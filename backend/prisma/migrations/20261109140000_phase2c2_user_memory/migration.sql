DO $$ BEGIN
  CREATE TYPE "MemorySuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "UserMemory" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "content" VARCHAR(2000) NOT NULL,
  "category" VARCHAR(40) NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "dedupeKey" TEXT NOT NULL,
  "searchVector" tsvector,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastRetrievedAt" TIMESTAMP(3),
  "retrievalCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MemorySuggestion" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "sourceConversationId" UUID,
  "sourceHighWaterSequence" INTEGER,
  "proposedContent" VARCHAR(2000) NOT NULL,
  "proposedCategory" VARCHAR(40) NOT NULL,
  "proposedTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "MemorySuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "dedupeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "createdMemoryId" UUID,
  CONSTRAINT "MemorySuggestion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UserMemory" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "UserMemory" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

CREATE OR REPLACE FUNCTION "northstar_update_user_memory_search_vector"() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple'::regconfig, coalesce(NEW."content", '') || ' ' || array_to_string(coalesce(NEW."tags", ARRAY[]::TEXT[]), ' '));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "UserMemory_searchVector_update" ON "UserMemory";
CREATE TRIGGER "UserMemory_searchVector_update" BEFORE INSERT OR UPDATE OF "content", "tags" ON "UserMemory"
  FOR EACH ROW EXECUTE FUNCTION "northstar_update_user_memory_search_vector"();
UPDATE "UserMemory" SET "searchVector" = to_tsvector('simple'::regconfig, coalesce("content", '') || ' ' || array_to_string(coalesce("tags", ARRAY[]::TEXT[]), ' '))
  WHERE "searchVector" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "MemorySuggestion_dedupeKey_key" ON "MemorySuggestion"("dedupeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "MemorySuggestion_createdMemoryId_key" ON "MemorySuggestion"("createdMemoryId");
CREATE UNIQUE INDEX IF NOT EXISTS "UserMemory_dedupeKey_key" ON "UserMemory"("dedupeKey");
CREATE INDEX IF NOT EXISTS "UserMemory_userId_updatedAt_idx" ON "UserMemory"("userId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "UserMemory_userId_category_idx" ON "UserMemory"("userId", "category");
CREATE INDEX IF NOT EXISTS "MemorySuggestion_userId_status_expiresAt_idx" ON "MemorySuggestion"("userId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "MemorySuggestion_sourceConversationId_sourceHighWaterSequence_idx" ON "MemorySuggestion"("sourceConversationId", "sourceHighWaterSequence");
CREATE INDEX IF NOT EXISTS "UserMemory_searchVector_gin_idx" ON "UserMemory" USING GIN ("searchVector");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserMemory_userId_fkey' AND conrelid = '"UserMemory"'::regclass) THEN
    ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemorySuggestion_userId_fkey' AND conrelid = '"MemorySuggestion"'::regclass) THEN
    ALTER TABLE "MemorySuggestion" ADD CONSTRAINT "MemorySuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemorySuggestion_sourceConversationId_fkey' AND conrelid = '"MemorySuggestion"'::regclass) THEN
    ALTER TABLE "MemorySuggestion" ADD CONSTRAINT "MemorySuggestion_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemorySuggestion_createdMemoryId_fkey' AND conrelid = '"MemorySuggestion"'::regclass) THEN
    ALTER TABLE "MemorySuggestion" ADD CONSTRAINT "MemorySuggestion_createdMemoryId_fkey" FOREIGN KEY ("createdMemoryId") REFERENCES "UserMemory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
