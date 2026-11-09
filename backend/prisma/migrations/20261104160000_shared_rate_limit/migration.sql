CREATE TABLE "RateLimitCounter" (
  "key" TEXT NOT NULL,
  "totalHits" INTEGER NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RateLimitCounter_resetAt_idx" ON "RateLimitCounter"("resetAt");
