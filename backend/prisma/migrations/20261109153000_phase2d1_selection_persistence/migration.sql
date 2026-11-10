CREATE TYPE "ModelSelectionMode" AS ENUM ('AUTO', 'MANUAL');

ALTER TABLE "UserSettings"
  ADD COLUMN "selectionMode" "ModelSelectionMode" NOT NULL DEFAULT 'MANUAL';

ALTER TABLE "Conversation"
  ADD COLUMN "selectionMode" "ModelSelectionMode" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "selectionModelId" TEXT;

ALTER TABLE "Message"
  ADD COLUMN "requestedSelectionMode" "ModelSelectionMode",
  ADD COLUMN "requestedModelId" TEXT,
  ADD COLUMN "taskType" TEXT,
  ADD COLUMN "routingPolicyVersion" TEXT,
  ADD COLUMN "routingReasonCode" TEXT;
