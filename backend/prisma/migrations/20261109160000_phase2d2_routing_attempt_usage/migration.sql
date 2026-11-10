-- Phase 2D.2 routing usage. Existing rows remain intact and are marked legacy
-- because their token provenance was not persisted before this migration.
ALTER TABLE "Message"
  ADD COLUMN "estimatedInputTokens" INTEGER,
  ADD COLUMN "estimatedOutputTokens" INTEGER,
  ADD COLUMN "usageStatus" TEXT;

ALTER TABLE "UsageRecord"
  ALTER COLUMN "inputTokens" DROP NOT NULL,
  ALTER COLUMN "outputTokens" DROP NOT NULL,
  ALTER COLUMN "estimatedCost" DROP NOT NULL,
  ADD COLUMN "estimatedInputTokens" INTEGER,
  ADD COLUMN "estimatedOutputTokens" INTEGER,
  ADD COLUMN "usageStatus" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "attemptId" UUID,
  ADD COLUMN "attemptNumber" INTEGER,
  ADD COLUMN "errorCode" TEXT;
ALTER TABLE "UsageRecord" ALTER COLUMN "usageStatus" SET DEFAULT 'provider_reported';

ALTER TABLE "UsageOutbox"
  ALTER COLUMN "inputTokens" DROP NOT NULL,
  ALTER COLUMN "outputTokens" DROP NOT NULL,
  ALTER COLUMN "estimatedCost" DROP NOT NULL,
  ADD COLUMN "estimatedInputTokens" INTEGER,
  ADD COLUMN "estimatedOutputTokens" INTEGER,
  ADD COLUMN "usageStatus" TEXT NOT NULL DEFAULT 'provider_reported',
  ADD COLUMN "attemptId" UUID,
  ADD COLUMN "attemptNumber" INTEGER,
  ADD COLUMN "errorCode" TEXT;

CREATE UNIQUE INDEX "UsageRecord_attemptId_key" ON "UsageRecord"("attemptId");
CREATE UNIQUE INDEX "UsageOutbox_attemptId_key" ON "UsageOutbox"("attemptId");
