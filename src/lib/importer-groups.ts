import { db } from "@/lib/db";

/**
 * Shared server-side validation for importer ↔ group assignment.
 *
 * Business rules (border-import regulation):
 *  - A selected group must exist and be ACTIVE.
 *  - A selected subgroup must exist and belong to the selected group.
 *  - Registered border workers (BORDER_WORKER) require a group.
 *  - A subgroup can only be set together with its parent group.
 *  - The group's official representative is a FK reference to an existing
 *    registered importer — personal data is never duplicated.
 *
 * Returns a Dari error message when invalid, otherwise null.
 */
export async function validateGroupAssignment(input: {
  importerType?: string | null;
  groupId?: number | null;
  subgroupId?: number | null;
}): Promise<string | null> {
  const { importerType, groupId, subgroupId } = input;

  if (groupId != null) {
    const group = await db.importerGroup.findUnique({ where: { id: groupId } });
    if (!group) return "گروپ انتخاب‌شده موجود نیست.";
    if (group.status !== "ACTIVE") return "گروپ انتخاب‌شده غیرفعال است؛ لطفاً گروپ فعال انتخاب کنید.";
  }

  if (subgroupId != null) {
    if (groupId == null) return "برای انتخاب زیرگروپ، ابتدا گروپ را انتخاب کنید.";
    const subgroup = await db.importerSubgroup.findUnique({ where: { id: subgroupId } });
    if (!subgroup) return "زیرگروپ انتخاب‌شده موجود نیست.";
    if (subgroup.groupId !== groupId) {
      return "زیرگروپ انتخاب‌شده به گروپ انتخاب‌شده تعلق ندارد.";
    }
    if (subgroup.status !== "ACTIVE") return "زیرگروپ انتخاب‌شده غیرفعال است.";
  }

  if (importerType === "BORDER_WORKER" && groupId == null) {
    return "برای کارگر مرزنشین، انتخاب گروپ ضروری است.";
  }

  if (groupId == null && subgroupId != null) {
    return "زیرگروپ بدون گروپ قابل ثبت نیست.";
  }

  return null;
}

/**
 * Validates the official representative of a group.
 * The representative MUST be an existing registered importer.
 * Returns a Dari error message when invalid, otherwise null.
 */
export async function validateGroupRepresentative(representativeId: number | null): Promise<string | null> {
  if (representativeId == null) return null; // representative is optional until assigned
  const importer = await db.importer.findUnique({
    where: { id: representativeId },
    select: { id: true, status: true },
  });
  if (!importer) return "نماینده مسئول باید یک واردکننده ثبت‌شده موجود باشد.";
  if (importer.status !== "ACTIVE") return "نماینده مسئول باید واردکننده فعال باشد.";
  return null;
}
