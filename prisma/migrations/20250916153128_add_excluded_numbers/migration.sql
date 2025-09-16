-- CreateTable
CREATE TABLE "public"."excluded_numbers" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "excluded_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "excluded_numbers_username_phoneNumber_key" ON "public"."excluded_numbers"("username", "phoneNumber");

-- AddForeignKey
ALTER TABLE "public"."excluded_numbers" ADD CONSTRAINT "excluded_numbers_username_fkey" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE CASCADE ON UPDATE CASCADE;
