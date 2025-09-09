-- CreateTable
CREATE TABLE "public"."chats" (
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageTimestamp" TIMESTAMP(6),
    "lastMessageText" TEXT,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("jid")
);

-- CreateTable
CREATE TABLE "public"."messages" (
    "id" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(6),
    "type" TEXT,
    "pushName" TEXT,
    "content" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."business_info" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT,
    "workingHours" TEXT,
    "locationUrl" TEXT,
    "shippingDetails" TEXT,
    "instagramUrl" TEXT,
    "websiteUrl" TEXT,
    "mobileNumbers" TEXT,
    "lastUpdated" TIMESTAMP(6),

    CONSTRAINT "business_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "tenantId" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "public"."business_info_tenant" (
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "workingHours" TEXT,
    "locationUrl" TEXT,
    "shippingDetails" TEXT,
    "instagramUrl" TEXT,
    "websiteUrl" TEXT,
    "mobileNumbers" TEXT,
    "lastUpdated" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_info_tenant_pkey" PRIMARY KEY ("tenantId")
);

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_jid_fkey" FOREIGN KEY ("jid") REFERENCES "public"."chats"("jid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."business_info_tenant" ADD CONSTRAINT "business_info_tenant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."users"("tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
