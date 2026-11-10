ALTER TABLE "UsageOutbox" DROP CONSTRAINT IF EXISTS "UsageOutbox_operation_check";
ALTER TABLE "UsageOutbox" ADD CONSTRAINT "UsageOutbox_operation_check"
  CHECK ("operation" IN ('chat', 'summary', 'memory_extraction'));
