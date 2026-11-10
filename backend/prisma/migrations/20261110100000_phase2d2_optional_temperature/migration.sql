-- Existing sampling preferences are preserved; null means use the selected provider's default.
ALTER TABLE "UserSettings" ALTER COLUMN "temperature" DROP NOT NULL;
ALTER TABLE "UserSettings" ALTER COLUMN "temperature" DROP DEFAULT;
