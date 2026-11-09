ALTER TABLE "Conversation" ADD COLUMN "lastMessageSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt", "id")::INTEGER AS seq
  FROM "Message"
)
UPDATE "Message" AS m SET "sequence" = ranked.seq FROM ranked WHERE m."id" = ranked."id";
UPDATE "Conversation" AS c SET "lastMessageSequence" = COALESCE((SELECT MAX(m."sequence") FROM "Message" AS m WHERE m."conversationId" = c."id"), 0);
ALTER TABLE "Message" ALTER COLUMN "sequence" DROP DEFAULT;
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");
CREATE INDEX "Message_conversationId_sequence_idx" ON "Message"("conversationId", "sequence");
CREATE TABLE "Session" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ConversationGenerationLock" (
  "conversationId" UUID NOT NULL,
  "ownerToken" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationGenerationLock_pkey" PRIMARY KEY ("conversationId")
);
CREATE INDEX "ConversationGenerationLock_expiresAt_idx" ON "ConversationGenerationLock"("expiresAt");
ALTER TABLE "ConversationGenerationLock" ADD CONSTRAINT "ConversationGenerationLock_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "DailyGuestQuota" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "day" DATE NOT NULL,
  "consumed" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "DailyGuestQuota_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyGuestQuota_userId_day_key" ON "DailyGuestQuota"("userId", "day");
ALTER TABLE "DailyGuestQuota" ADD CONSTRAINT "DailyGuestQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
