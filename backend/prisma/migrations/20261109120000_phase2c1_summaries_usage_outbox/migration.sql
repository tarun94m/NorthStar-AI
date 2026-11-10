ALTER TABLE "Conversation" ADD COLUMN "transcriptRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "UsageRecord" ADD COLUMN "operation" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "UsageRecord" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "UsageRecord" SET "idempotencyKey" = 'legacy:' || "id"::text WHERE "idempotencyKey" IS NULL;
ALTER TABLE "UsageRecord" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "UsageRecord_idempotencyKey_key" ON "UsageRecord"("idempotencyKey");

CREATE TABLE "ConversationSummary" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "coveredThroughSequence" INTEGER NOT NULL,
  "sourceHighWaterSequence" INTEGER NOT NULL,
  "transcriptRevision" INTEGER NOT NULL,
  "summaryText" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationSummary_status_check" CHECK ("status" IN ('active', 'superseded', 'invalidated')),
  CONSTRAINT "ConversationSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationSummary_conversationId_version_key" ON "ConversationSummary"("conversationId", "version");
CREATE UNIQUE INDEX "ConversationSummary_one_active_per_conversation_key" ON "ConversationSummary"("conversationId") WHERE "status" = 'active';
CREATE INDEX "ConversationSummary_conversationId_status_idx" ON "ConversationSummary"("conversationId", "status");
CREATE INDEX "ConversationSummary_conversationId_coveredThroughSequence_idx" ON "ConversationSummary"("conversationId", "coveredThroughSequence");

CREATE TABLE "ConversationSummaryJob" (
  "conversationId" UUID NOT NULL,
  "requestedThroughSequence" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID,
  "leaseGeneration" BIGINT NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationSummaryJob_pkey" PRIMARY KEY ("conversationId"),
  CONSTRAINT "ConversationSummaryJob_status_check" CHECK ("status" IN ('queued', 'leased', 'complete')),
  CONSTRAINT "ConversationSummaryJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ConversationSummaryJob_claim_idx" ON "ConversationSummaryJob"("status", "availableAt", "leaseExpiresAt");

CREATE TABLE "UsageOutbox" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "conversationId" UUID,
  "messageId" UUID,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "estimatedCost" DOUBLE PRECISION NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageOutbox_operation_check" CHECK ("operation" IN ('chat', 'summary')),
  CONSTRAINT "UsageOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UsageOutbox_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "UsageOutbox_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UsageOutbox_idempotencyKey_key" ON "UsageOutbox"("idempotencyKey");
CREATE INDEX "UsageOutbox_delivery_idx" ON "UsageOutbox"("deliveredAt", "availableAt", "leaseExpiresAt");
