/**
 * Envío de emails transaccionales (licencia, suspensión, baja).
 *
 * Si falta cualquiera de host/user/pass → `enabled = false` y los métodos sólo
 * loguean por consola lo que habrían enviado (útil en dev / tests).
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailConfig {
  host?: string;
  user?: string;
  pass?: string;
  from: string;
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <h1 style="font-size:20px;color:#111827;margin:0 0 16px;">StockFlow</h1>
    <h2 style="font-size:16px;color:#374151;margin:0 0 16px;">${title}</h2>
    ${bodyHtml}
    <p style="font-size:12px;color:#9ca3af;margin-top:32px;">Este es un mensaje automático, no respondas a este correo.</p>
  </div>
</body></html>`;
}

export class EmailService {
  readonly enabled: boolean;
  private readonly from: string;
  private readonly transporter: Transporter | null;

  constructor(config: EmailConfig) {
    this.from = config.from;
    if (config.host && config.user && config.pass) {
      this.enabled = true;
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: 587,
        auth: { user: config.user, pass: config.pass },
      });
    } else {
      this.enabled = false;
      this.transporter = null;
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.enabled || !this.transporter) {
      console.log(`[EmailService] (deshabilitado) email a ${to}: "${subject}"`);
      return;
    }
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, html });
    } catch (err) {
      console.error(`[EmailService] error enviando email a ${to}:`, err);
    }
  }

  async sendLicenseEmail(to: string, name: string, licenseKey: string, plan: string): Promise<void> {
    const html = layout(
      '¡Tu licencia está lista!',
      `<p style="color:#374151;">Hola ${name}, gracias por suscribirte al <strong>Plan ${plan}</strong> de StockFlow.</p>
       <p style="color:#374151;">Tu clave de licencia es:</p>
       <p style="font-size:22px;font-weight:bold;letter-spacing:1px;background:#eef2ff;color:#1e3a8a;padding:16px;border-radius:8px;text-align:center;">${licenseKey}</p>
       <p style="color:#374151;">Abrí StockFlow en tu PC, pegá esta clave en la pantalla de activación y listo. La licencia queda vinculada a esa computadora.</p>`,
    );
    await this.send(to, 'Tu licencia de StockFlow', html);
  }

  async sendSuspendedEmail(to: string, name: string): Promise<void> {
    const html = layout(
      'Suscripción suspendida',
      `<p style="color:#374151;">Hola ${name}, detectamos pagos rechazados en tu suscripción de StockFlow y la suspendimos temporalmente.</p>
       <p style="color:#374151;">Regularizá el pago para reactivar el acceso. Si necesitás ayuda, escribinos.</p>`,
    );
    await this.send(to, 'Tu suscripción de StockFlow fue suspendida', html);
  }

  async sendCancelledEmail(to: string, name: string): Promise<void> {
    const html = layout(
      'Suscripción cancelada',
      `<p style="color:#374151;">Hola ${name}, tu suscripción de StockFlow fue cancelada y las licencias asociadas quedaron revocadas.</p>
       <p style="color:#374151;">Cuando quieras volver, podés darte de alta nuevamente desde la web.</p>`,
    );
    await this.send(to, 'Tu suscripción de StockFlow fue cancelada', html);
  }
}
