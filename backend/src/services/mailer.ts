/**
 * mailer.ts — nodemailer SMTP transport + email templates.
 *
 * All sends are best-effort: a missing SMTP config or a transport error
 * is logged and swallowed — it must never block registration or login.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { CFG } from "../config.js";

let _transporter: Transporter | undefined;

/** Lazy singleton. Returns null if SMTP_HOST is not configured. */
function getTransporter(): Transporter | null {
	if (!CFG.SMTP_HOST) return null;
	if (!_transporter) {
		_transporter = nodemailer.createTransport({
			host: CFG.SMTP_HOST,
			port: CFG.SMTP_PORT,
			secure: CFG.SMTP_SECURE,
			auth: {
				user: CFG.SMTP_USER,
				pass: CFG.SMTP_PASS,
			},
		});
	}
	return _transporter;
}

export interface MailOptions {
	to: string;
	subject: string;
	html: string;
	text: string;
}

/**
 * Send an email. Best-effort — never throws.
 * Logs a warning when SMTP is unconfigured and logs errors on delivery failure.
 */
export async function sendMail(opts: MailOptions): Promise<void> {
	const transporter = getTransporter();
	if (!transporter) {
		console.warn(
			`[mailer] SMTP_HOST is not configured — skipping email to ${opts.to}`,
		);
		return;
	}
	try {
		await transporter.sendMail({
			from: CFG.EMAIL_FROM,
			to: opts.to,
			subject: opts.subject,
			html: opts.html,
			text: opts.text,
		});
	} catch (err) {
		console.error(`[mailer] Failed to send email to ${opts.to}:`, err);
	}
}

// ─── Templates ────────────────────────────────────────────────────────────────

export interface WelcomeEmailParams {
	name: string;
	memberCode: string;
	sponsorCode: string;
	date: string; // formatted date string, e.g. "14 July 2026"
	email: string;
}

export function welcomeEmailTemplate(p: WelcomeEmailParams): MailOptions {
	const subject = "🎉 Welcome to Agila Vetri Groups – Registration Successful!";

	const text = `
Dear ${p.name},

Welcome to Agila Vetri Groups – Creating Millionaires!

We are delighted to inform you that your registration has been successfully completed.

Registration Details
Member Name:      ${p.name}
Member ID:        ${p.memberCode}
Sponsor ID:       ${p.sponsorCode}
Registration Date: ${p.date}

You are now officially a part of the Agila Vetri Groups Pair Matching Program.

What's Next?
✅ Log in to your member dashboard.
✅ Complete your profile and KYC.
✅ Start building your team by referring 2 direct members.
✅ Track your referrals, pair matching, and rewards.
✅ Attend training sessions and stay connected with the community.

We are committed to helping you achieve your financial and business goals through teamwork, leadership, and continuous growth.

If you need any assistance, our support team is always here to help.

Welcome aboard, and wishing you great success!

Best Regards,
Agila Vetri Groups
Creating Millionaires | Creating Leaders | Creating Success
📧 support@agilavertiglobal.com
`.trim();

	const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0E1526;font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0E1526;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#131B33;border-radius:16px;overflow:hidden;max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1e3a8a,#1e40af);padding:40px 40px 32px;text-align:center;">
              <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                🎉 Welcome to Agila Vetri Groups!
              </h1>
              <p style="margin:10px 0 0;font-size:14px;color:#93c5fd;">Creating Millionaires | Creating Leaders | Creating Success</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;font-size:16px;color:#cbd5e1;">Dear <strong style="color:#f1f5f9;">${p.name}</strong>,</p>
              <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
                We are delighted to inform you that your registration has been <strong style="color:#22c55e;">successfully completed</strong>.
                You are now officially a part of the Agila Vetri Groups Pair Matching Program.
              </p>

              <!-- Registration Details -->
              <div style="background:#0E1526;border-radius:12px;padding:24px;margin-bottom:28px;border:1px solid #1e3a8a;">
                <h2 style="margin:0 0 16px;font-size:14px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:1px;">Registration Details</h2>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#64748b;width:40%;">Member Name</td>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#f1f5f9;font-weight:600;">${p.name}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#64748b;">Member ID</td>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#60a5fa;font-weight:700;font-family:monospace;">${p.memberCode}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#64748b;">Sponsor ID</td>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;font-size:13px;color:#f1f5f9;font-family:monospace;">${p.sponsorCode}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;font-size:13px;color:#64748b;">Registration Date</td>
                    <td style="padding:8px 0;font-size:13px;color:#f1f5f9;">${p.date}</td>
                  </tr>
                </table>
              </div>

              <!-- What's Next -->
              <h2 style="margin:0 0 16px;font-size:14px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:1px;">What's Next?</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                ${[
				"Log in to your member dashboard.",
				"Complete your profile and KYC.",
				"Start building your team by referring 2 direct members.",
				"Track your referrals, pair matching, and rewards.",
				"Attend training sessions and stay connected with the community.",
			]
				.map(
					(item) => `
                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#cbd5e1;vertical-align:top;">
                    <span style="color:#22c55e;margin-right:10px;font-size:16px;">✅</span>${item}
                  </td>
                </tr>`,
				)
				.join("")}
              </table>

              <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.7;">
                We are committed to helping you achieve your financial and business goals through teamwork, leadership, and continuous growth.
                If you need any assistance, our support team is always here to help.
              </p>
              <p style="margin:0;font-size:15px;color:#cbd5e1;">Welcome aboard, and wishing you great success! 🚀</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0a0f1e;padding:24px 40px;text-align:center;border-top:1px solid #1e293b;">
              <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#60a5fa;">Agila Vetri Groups</p>
              <p style="margin:0 0 6px;font-size:12px;color:#475569;">Creating Millionaires | Creating Leaders | Creating Success</p>
              <p style="margin:0;font-size:12px;color:#475569;">📧 support@agilavertiglobal.com</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

	return { to: p.email, subject, html, text };
}

export interface OtpEmailParams {
	name: string;
	email: string;
	code: string;
}

export function otpEmailTemplate(p: OtpEmailParams): MailOptions {
	const subject = "Your Agila Vetri Groups Login Code";

	const text = `
Dear ${p.name},

Your one-time login code is: ${p.code}

This code is valid for 5 minutes. Do not share it with anyone.

If you did not request this code, please contact us immediately at support@agilavertiglobal.com.

Best Regards,
Agila Vetri Groups
`.trim();

	const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0E1526;font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0E1526;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#131B33;border-radius:16px;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1e3a8a,#1e40af);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;font-size:20px;font-weight:800;color:#ffffff;">🔐 Login Verification</h1>
              <p style="margin:8px 0 0;font-size:13px;color:#93c5fd;">Agila Vetri Groups</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;color:#cbd5e1;">Dear <strong style="color:#f1f5f9;">${p.name}</strong>,</p>
              <p style="margin:0 0 28px;font-size:14px;color:#94a3b8;">Use the code below to complete your login.</p>

              <!-- OTP Box -->
              <div style="background:#0E1526;border:2px solid #1e40af;border-radius:12px;padding:28px 20px;margin-bottom:28px;display:inline-block;width:100%;box-sizing:border-box;">
                <p style="margin:0 0 8px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:2px;">Your Login Code</p>
                <p style="margin:0;font-size:44px;font-weight:900;letter-spacing:12px;color:#60a5fa;font-family:monospace;">${p.code}</p>
                <p style="margin:12px 0 0;font-size:12px;color:#ef4444;">Valid for 5 minutes only</p>
              </div>

              <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;">
                Do not share this code with anyone. If you did not request this,
                please contact <a href="mailto:support@agilavertiglobal.com" style="color:#60a5fa;">support@agilavertiglobal.com</a> immediately.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0a0f1e;padding:20px 40px;text-align:center;border-top:1px solid #1e293b;">
              <p style="margin:0;font-size:12px;color:#475569;">Agila Vetri Groups · 📧 support@agilavertiglobal.com</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

	return { to: p.email, subject, html, text };
}
