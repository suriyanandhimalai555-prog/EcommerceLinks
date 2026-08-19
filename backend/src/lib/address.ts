/**
 * address.ts — shared Zod schema + helper for delivery addresses.
 *
 * Used by:
 *   - PUT /me/address          (member sets their address once)
 *   - PUT /admin/members/:id/address  (management can always edit)
 *   - POST /orders gate        (requires address before order creation)
 *   - POST /admin/orders/on-behalf gate
 *   - confirmOrder() snapshot  (copies member cols into order ship cols)
 */
import { z } from "zod";

export const AddressBody = z.object({
	recipientName: z.string().min(1, "Recipient name is required"),
	phone:         z.string().min(10, "Valid phone number is required"),
	line1:         z.string().min(1, "Address line 1 is required"),
	line2:         z.string().optional(),
	city:          z.string().min(1, "City is required"),
	state:         z.string().min(1, "State is required"),
	pincode:       z.string().regex(/^\d{6}$/, "Pincode must be exactly 6 digits"),
});

export type AddressInput = z.infer<typeof AddressBody>;

/**
 * Returns true when the member row has every required address field filled.
 * This is the single source of truth — both the gate and the banner use it.
 */
export function isCompleteAddress(row: {
	addr_recipient_name?: string | null;
	addr_phone?:          string | null;
	addr_line1?:          string | null;
	addr_city?:           string | null;
	addr_state?:          string | null;
	addr_pincode?:        string | null;
}): boolean {
	return Boolean(
		row.addr_recipient_name?.trim() &&
		row.addr_phone?.trim() &&
		row.addr_line1?.trim() &&
		row.addr_city?.trim() &&
		row.addr_state?.trim() &&
		row.addr_pincode?.trim(),
	);
}
