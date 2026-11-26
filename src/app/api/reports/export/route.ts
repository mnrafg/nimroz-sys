import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { fail, handleApiError, requireUser } from "@/lib/api";
import { buildReport, type ReportData } from "@/lib/reports";
import { importerVisibilityWhere, requirePortScope } from "@/lib/scope";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Exports obey the SAME server-enforced port scope as on-screen reports.
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const visibility = importerVisibilityWhere(auth.user);
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "daily";
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : null;
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : null;
    const requestedCheckpointId = searchParams.get("checkpointId") ? Number(searchParams.get("checkpointId")) : null;
    const importerId = searchParams.get("importerId") ? Number(searchParams.get("importerId")) : null;
    const groupId = searchParams.get("groupId") ? Number(searchParams.get("groupId")) : null;
    const itemId = searchParams.get("itemId") ? Number(searchParams.get("itemId")) : null;
    const q = searchParams.get("q");

    const checkpointId =
      scopeCheck.scope.kind === "port" ? scopeCheck.scope.checkpointId : requestedCheckpointId;

    const report: ReportData = await buildReport(
      type,
      { from, to, checkpointId, importerId, groupId, itemId, q, importerVisibility: visibility },
      auth.user.name
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "AOGC Border Import Control System";
    wb.created = new Date();
    const ws = wb.addWorksheet(report.title.slice(0, 30), {
      views: [{ rightToLeft: true }],
    });

    ws.mergeCells(1, 1, 1, Math.max(report.columns.length, 4));
    ws.getCell(1, 1).value = `${report.title} — سیستم کنترل واردات مرزی AOGC`;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: "FF0B4F3A" } };
    ws.getCell(1, 1).alignment = { horizontal: "center" };

    const metaParts: string[] = [];
    if (report.meta.from) metaParts.push(`از تاریخ: ${report.meta.from}`);
    if (report.meta.to) metaParts.push(`تا تاریخ: ${report.meta.to}`);
    if (report.meta.checkpointName) metaParts.push(`بندر: ${report.meta.checkpointName}`);
    if (report.meta.importerName) metaParts.push(`واردکننده: ${report.meta.importerName}`);
    if (report.meta.groupName) metaParts.push(`گروپ: ${report.meta.groupName}`);
    if (report.meta.itemName) metaParts.push(`جنس: ${report.meta.itemName}`);
    metaParts.push(`ایجادکننده: ${report.meta.generatedBy}`);
    metaParts.push(`تاریخ گزارش: ${report.meta.generatedAt}`);

    ws.mergeCells(2, 1, 2, Math.max(report.columns.length, 4));
    ws.getCell(2, 1).value = metaParts.join("  |  ");
    ws.getCell(2, 1).font = { size: 10, color: { argb: "FF666666" } };
    ws.getCell(2, 1).alignment = { horizontal: "center" };

    // Summary block
    let rowIdx = 4;
    for (const s of report.summary) {
      ws.getCell(rowIdx, 1).value = s.label;
      ws.getCell(rowIdx, 1).font = { bold: true };
      ws.getCell(rowIdx, 2).value = s.value as string | number;
      rowIdx++;
    }
    rowIdx++;

    const headerRowIdx = rowIdx;
    const headerRow = ws.getRow(headerRowIdx);
    report.columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B4F3A" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: { style: "thin" }, bottom: { style: "thin" },
        left: { style: "thin" }, right: { style: "thin" },
      };
    });

    report.rows.forEach((r, ri) => {
      const row = ws.getRow(headerRowIdx + 1 + ri);
      report.columns.forEach((col, ci) => {
        const cell = row.getCell(ci + 1);
        const raw = r[col.key];
        cell.value =
          col.type === "number" && typeof raw === "number" ? raw : String(raw ?? "");
        cell.alignment = { horizontal: col.type === "number" ? "center" : "right", vertical: "middle" };
        cell.border = {
          top: { style: "hair" }, bottom: { style: "hair" },
          left: { style: "hair" }, right: { style: "hair" },
        };
        if (col.type === "number") cell.numFmt = "#,##0.###";
      });
    });

    report.columns.forEach((col, i) => {
      let maxLen = col.label.length;
      for (const r of report.rows) {
        const l = String(r[col.key] ?? "").length;
        if (l > maxLen) maxLen = l;
      }
      ws.getColumn(i + 1).width = Math.min(Math.max(maxLen * 0.9 + 4, 10), 55);
    });
    ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 10, 18);

    const buffer = await wb.xlsx.writeBuffer();
    const fileName = `report-${type}-${Date.now()}.xlsx`;

    return new Response(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
