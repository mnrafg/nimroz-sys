"use client";

import * as React from "react";
import { Fingerprint, Server } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared";
import { TerminalDevicesPanel } from "@/components/biometric/terminal-devices-panel";
import { TerminalAdmsServerSettings } from "@/components/biometric/terminal-adms-server-settings";
import { breadcrumbItems } from "@/lib/nav";

// ============================================================
// تنظیمات دستگاه‌های بایومتریک — admin page for the physical
// border terminals: the device registry (LAN / ADMS_SERVER) and
// the shared ADMS destination those devices connect to.
// ============================================================

export function TerminalDevicesView() {
  return (
    <div>
      <PageHeader
        title="تنظیمات دستگاه‌های بایومتریک"
        description="مدیریت ترمینال‌های فیزیکی بندر و مشاهده وضعیت اتصال به سرور ADMS موجود"
        breadcrumbs={breadcrumbItems("terminal-devices")}
      />

      <Tabs defaultValue="devices" dir="rtl">
        <TabsList className="mb-4 h-10">
          <TabsTrigger value="devices" className="gap-1.5 px-4">
            <Fingerprint className="size-4" aria-hidden />
            دستگاه‌های بایومتریک
          </TabsTrigger>
          <TabsTrigger value="adms" className="gap-1.5 px-4">
            <Server className="size-4" aria-hidden />
            وضعیت ADMS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="mt-0">
          <TerminalDevicesPanel />
        </TabsContent>

        <TabsContent value="adms" className="mt-0">
          <TerminalAdmsServerSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
