import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import _ from "lodash";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as resyncAttributeKeyCounts from "@/jobs/update-attribute/resync-attribute-key-counts";
import * as resyncAttributeValueCounts from "@/jobs/update-attribute/resync-attribute-value-counts";

const QUEUE_NAME = "metadata-index-write-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 1000,
    removeOnFail: 1000,
    timeout: 60000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { collection, contract, tokenId, name, description, imageUrl, mediaUrl, attributes } =
        job.data as TokenMetadataInfo;

      try {
        // Prepare the attributes for caching in the `tokens` table.
        const attrs: string[] = [];
        const attrsParams: { [key: string]: string } = {};
        for (let i = 0; i < attributes.length; i++) {
          attrs.push(`[$/attribute${i}/, NULL]`);
          attrsParams[`attribute${i}`] = `${attributes[i].key},${attributes[i].value}`;
        }

        // Update the token's metadata.
        const result = await idb.oneOrNone(
          `
            UPDATE tokens SET
              name = $/name/,
              description = $/description/,
              image = $/image/,
              media = $/media/,
              attributes = ${attrs.length ? `HSTORE(ARRAY[${attrs.join(", ")}])` : "NULL"},
              updated_at = now()
            WHERE tokens.contract = $/contract/
              AND tokens.token_id = $/tokenId/
            RETURNING 1
          `,
          {
            contract: toBuffer(contract),
            tokenId,
            name: name || null,
            description: description || null,
            image: imageUrl || null,
            media: mediaUrl || null,
            ...attrsParams,
          }
        );
        if (!result) {
          // Skip if there is no associated entry in the `tokens` table
          return;
        }

        // Clear the current token attributes
        const attributesToRefresh = await idb.manyOrNone(
          `DELETE FROM token_attributes
                 WHERE contract = $/contract/
                 AND token_id = $/tokenId/
                 RETURNING key, value`,
          {
            contract: toBuffer(contract),
            tokenId,
          }
        );

        // Schedule attribute refresh
        _.forEach(attributesToRefresh, (attribute) => {
          resyncAttributeKeyCounts.addToQueue(collection, attribute.key);
          resyncAttributeValueCounts.addToQueue(collection, attribute.key, attribute.value);
        });

        // Token attributes
        for (const { key, value, kind, rank } of attributes) {
          // Try to update the attribute keys, if number type update range as well and return the ID
          let attributeKeyResult = await idb.oneOrNone(
            `
              UPDATE attribute_keys
              SET info = CASE WHEN kind = 'number' THEN
                    info || jsonb_object(array['min_range', 'max_range'], array[
                        CASE
                            WHEN (info->>'min_range')::numeric > $/value/::numeric THEN $/value/::numeric
                            ELSE (info->>'min_range')::numeric
                        END,
                        CASE
                            WHEN (info->>'max_range')::numeric < $/value/::numeric THEN $/value/::numeric
                            ELSE (info->>'max_range')::numeric
                        END
                    ]::text[])
                    END
              WHERE collection_id = $/collection/
              AND key = $/key/
              RETURNING id
            `,
            {
              collection,
              key: String(key),
              value,
            }
          );

          if (!attributeKeyResult?.id) {
            let info = null;
            if (kind == "number") {
              info = { min_range: Number(value), max_range: Number(value) };
            }

            logger.info(
              QUEUE_NAME,
              `New attribute key collection=${collection}, key=${key}, kind=${kind}, info=${JSON.stringify(
                info
              )}`
            );

            // If no attribute key is available, then save it and refetch
            attributeKeyResult = await idb.oneOrNone(
              `
                INSERT INTO "attribute_keys" (
                  "collection_id",
                  "key",
                  "kind",
                  "rank",
                  "info"
                ) VALUES (
                  $/collection/,
                  $/key/,
                  $/kind/,
                  $/rank/,
                  $/info/
                )
                ON CONFLICT DO NOTHING
                RETURNING "id"
              `,
              {
                collection,
                key: String(key),
                kind,
                rank: rank || null,
                info,
              }
            );
          } else {
            logger.info(
              QUEUE_NAME,
              `Updated attribute key collection=${collection}, key=${key}, kind=${kind}`
            );
          }

          if (!attributeKeyResult?.id) {
            // Otherwise, fail (and retry)
            throw new Error(`Could not fetch/save attribute key "${key}"`);
          }

          // Fetch the attribute from the database (will succeed in the common case)
          let attributeResult = await idb.oneOrNone(
            `
              SELECT id
              FROM attributes
              WHERE attribute_key_id = $/attributeKeyId/
              AND value = $/value/
            `,
            {
              attributeKeyId: attributeKeyResult.id,
              value: String(value),
            }
          );

          if (!attributeResult?.id) {
            // If no attribute is not available, then save it and refetch
            attributeResult = await idb.oneOrNone(
              `
                WITH "x" AS (
                  INSERT INTO "attributes" (
                    "attribute_key_id",
                    "value",
                    "sell_updated_at",
                    "buy_updated_at",
                    "collection_id",
                    "kind",
                    "key"
                  ) VALUES (
                    $/attributeKeyId/,
                    $/value/,
                    NOW(),
                    NOW(),
                    $/collection/,
                    $/kind/,
                    $/key/
                  )
                  ON CONFLICT DO NOTHING
                  RETURNING "id"
                )
                
                UPDATE attribute_keys
                SET attribute_count = "attribute_count" + (SELECT COUNT(*) FROM "x")
                WHERE id = $/attributeKeyId/
                RETURNING (SELECT x.id FROM "x"), "attribute_count"
              `,
              {
                attributeKeyId: attributeKeyResult.id,
                value: String(value),
                collection,
                kind,
                key: String(key),
              }
            );
          }

          if (!attributeResult?.id) {
            // Otherwise, fail (and retry)
            throw new Error(`Could not fetch/save attribute "${value}"`);
          }

          let sampleImageUpdate = "";
          if (imageUrl) {
            sampleImageUpdate = `
            ,sample_images = CASE WHEN (sample_images IS NULL OR array_length(sample_images, 1) < 4) AND array_position(sample_images, $/image/) IS NULL
                    THEN array_prepend($/image/, sample_images)
                 WHEN (array_length(sample_images, 1) >= 4) AND array_position(sample_images, $/image/) IS NULL
                    THEN array_prepend($/image/, array_remove(sample_images, sample_images[4]))
                 ELSE sample_images
            END`;
          }

          // Associate the attribute with the token
          await idb.none(
            `
              WITH "x" AS (
                INSERT INTO "token_attributes" (
                  "contract",
                  "token_id",
                  "attribute_id",
                  "collection_id",
                  "key",
                  "value"
                ) VALUES (
                  $/contract/,
                  $/tokenId/,
                  $/attributeId/,
                  $/collection/,
                  $/key/,
                  $/value/
                )
                ON CONFLICT DO NOTHING
                RETURNING 1
              )
              UPDATE attributes
              SET token_count = token_count + (SELECT COUNT(*) FROM "x")
                  ${sampleImageUpdate}
              WHERE id = $/attributeId/
            `,
            {
              contract: toBuffer(contract),
              tokenId,
              attributeId: attributeResult.id,
              image: imageUrl || null,
              collection,
              key: String(key),
              value: String(value),
            }
          );
        }

        // Mark the token as having metadata indexed.
        await idb.none(
          `
            UPDATE tokens SET metadata_indexed = TRUE
            WHERE tokens.contract = $/contract/
              AND tokens.token_id = $/tokenId/
              AND tokens.metadata_indexed IS DISTINCT FROM TRUE
          `,
          {
            contract: toBuffer(contract),
            tokenId,
          }
        );
      } catch (error) {
        logger.error(
          QUEUE_NAME,
          `Failed to process token metadata info ${JSON.stringify(job.data)}: ${error}`
        );
        throw error;
      }
    },
    { connection: redis.duplicate(), concurrency: 30 }
  );
  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type TokenMetadataInfo = {
  collection: string;
  contract: string;
  tokenId: string;
  name?: string;
  description?: string;
  imageUrl?: string;
  mediaUrl?: string;
  attributes: {
    key: string;
    value: string;
    kind: "string" | "number" | "date" | "range";
    rank?: number;
  }[];
};

export const addToQueue = async (tokenMetadataInfos: TokenMetadataInfo[]) => {
  await queue.addBulk(
    tokenMetadataInfos
      .map((tokenMetadataInfo) => ({
        name: `${tokenMetadataInfo.contract}-${tokenMetadataInfo.tokenId}`,
        data: tokenMetadataInfo,
      }))
      .filter(({ data }) => data.collection && data.contract && data.tokenId && data.attributes)
  );
};
