ALTER TABLE "UsageOutbox"
  ADD COLUMN "pricingCurrency" VARCHAR(3),
  ADD COLUMN "pricingVersion" VARCHAR(80),
  ADD COLUMN "pricingEffectiveAt" TIMESTAMP(3);

ALTER TABLE "UsageRecord"
  ADD COLUMN "pricingCurrency" VARCHAR(3),
  ADD COLUMN "pricingVersion" VARCHAR(80),
  ADD COLUMN "pricingEffectiveAt" TIMESTAMP(3);

ALTER TABLE "Message" ADD COLUMN "pricingCurrency" VARCHAR(3);

-- The pre-existing cost contract explicitly used USD. Keep those recorded values
-- intact and backfill only their known currency; their historical version and
-- provider-effective date are unknown and remain NULL.
UPDATE "UsageOutbox" SET "pricingCurrency" = 'USD' WHERE "pricingCurrency" IS NULL;
UPDATE "UsageRecord" SET "pricingCurrency" = 'USD' WHERE "pricingCurrency" IS NULL;
UPDATE "Message" SET "pricingCurrency" = 'USD' WHERE "estimatedCost" IS NOT NULL;
