-- CreateIndex
CREATE INDEX "verification_tokens_companyId_purpose_consumedAt_idx" ON "verification_tokens"("companyId", "purpose", "consumedAt");

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
