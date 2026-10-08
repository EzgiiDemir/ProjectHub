import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { Ctx } from './context.js';

/** Sends transactional e-mail when SMTP is configured. Callers fall back to showing links in the UI otherwise. */
@Injectable()
export class Mailer {
  private readonly transporter: Transporter | null;

  constructor(private readonly ctx: Ctx) {
    const c = ctx.config;
    this.transporter = c.SMTP_HOST
      ? nodemailer.createTransport({
          host: c.SMTP_HOST,
          port: c.SMTP_PORT,
          secure: c.SMTP_PORT === 465,
          auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
        })
      : null;
  }

  get enabled(): boolean {
    return this.transporter !== null;
  }

  /** Returns true when the message was handed to the SMTP server. */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({ from: this.ctx.config.SMTP_FROM, to, subject, text });
      return true;
    } catch (e) {
      this.ctx.logger.error({ err: e, to }, 'e-mail delivery failed');
      return false;
    }
  }
}
