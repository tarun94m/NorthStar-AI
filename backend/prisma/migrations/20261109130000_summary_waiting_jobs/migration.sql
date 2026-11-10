ALTER TABLE "ConversationSummaryJob" DROP CONSTRAINT "ConversationSummaryJob_status_check";
ALTER TABLE "ConversationSummaryJob" ADD CONSTRAINT "ConversationSummaryJob_status_check"
  CHECK ("status" IN ('queued', 'leased', 'complete', 'waiting'));
