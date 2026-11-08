/**
 * SPEC 06 §8 — consent and the data-sent log.
 *
 * Two rules this file exists to enforce:
 *  1. Nothing leaves the computer until the user has allowed that provider to
 *     receive that *category* of data. "Allow once" is consumed by the task that
 *     asked for it; "Always allow" persists in workspace.db.
 *  2. The log records metadata only (host, task, category, approximate size) —
 *     never the text or audio that was sent.
 */

import { uuidv7 } from '@clipwright/project-schema';
import type { ConsentRecord, DataSentEntry, StorageService } from '../storage/storage-service.js';
import type { Logger } from '../storage/logger.js';

export type ConsentCategory = 'transcript' | 'audio' | 'test_payload';
export type ConsentScope = 'once' | 'always';

export interface ConsentPrompt {
  providerId: string;
  providerName: string;
  host: string;
  category: ConsentCategory;
  /** "another computer on your network" for LAN providers, "the internet" otherwise. */
  where: string;
  /** The exact sentence the dialog shows, built once here so UI can't drift. */
  message: string;
  sent: string;
  neverSent: string;
}

export interface ConsentDecision {
  providerId: string;
  category: ConsentCategory;
  scope: ConsentScope;
}

export interface PrivacyOverview {
  consents: Array<ConsentRecord & { providerName?: string }>;
  dataSent: DataSentEntry[];
  /** The four outbound calls the app can make, per SPEC 06 §8. */
  backgroundCalls: Array<{
    id: string;
    label: string;
    detail: string;
    toggleKey: 'updateCheck' | 'ytDlpUpdate' | null;
    /** null for calls that only happen when the user triggers them. */
    enabled: boolean | null;
  }>;
}

const CATEGORY_COPY: Record<ConsentCategory, { sent: string; neverSent: string }> = {
  audio: {
    sent: 'audio chunks (mono, 16 kHz, compressed)',
    neverSent: 'video, your project, or file names',
  },
  transcript: {
    sent: 'transcript text with timestamps and numeric audio features',
    neverSent: 'audio, video, thumbnails, file paths, or other projects',
  },
  test_payload: {
    sent: 'a short synthetic test payload',
    neverSent: 'anything of yours',
  },
};

export class ConsentService {
  private storage: StorageService;
  private logger: Logger;

  constructor(storage: StorageService, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  /** The dialog content for the first use of a provider+category pair. */
  buildPrompt(input: {
    providerId: string;
    providerName: string;
    locality: 'local' | 'network' | 'online';
    host: string;
    category: ConsentCategory;
  }): ConsentPrompt {
    const copy = CATEGORY_COPY[input.category];
    const where = input.locality === 'network' ? 'another computer on your network' : 'the internet';
    const message =
      input.locality === 'network'
        ? `This will send ${copy.sent} to ${input.providerName}, which is another computer on your network (${input.host}). ${input.providerName} has its own privacy terms.`
        : `This will send ${copy.sent} to ${input.providerName} (${input.host}) over ${where}. ${input.providerName} has its own privacy terms.`;
    return {
      providerId: input.providerId,
      providerName: input.providerName,
      host: input.host,
      category: input.category,
      where,
      message,
      sent: copy.sent,
      neverSent: copy.neverSent,
    };
  }

  /** True when the task may send data to this provider right now. */
  isGranted(providerId: string, category: ConsentCategory): boolean {
    return Boolean(this.storage.findConsent(providerId, category));
  }

  grant(decision: ConsentDecision): ConsentRecord {
    const id = `${decision.providerId}:${decision.category}`;
    const existing = this.storage.findConsent(decision.providerId, decision.category);
    const record: ConsentRecord = {
      id: existing?.id ?? id,
      providerId: decision.providerId,
      category: decision.category,
      scope: decision.scope,
      grantedAt: new Date().toISOString(),
    };
    this.storage.saveConsent(record);
    this.logger.info('Consent granted', { providerId: decision.providerId, category: decision.category, scope: decision.scope });
    return record;
  }

  /** "Allow once" must not survive the task that asked for it. */
  consumeOneTime(providerId: string, category: ConsentCategory): void {
    const existing = this.storage.findConsent(providerId, category);
    if (existing && existing.scope === 'once') {
      this.storage.deleteConsent(existing.id);
    }
  }

  revoke(providerId: string, category: ConsentCategory): void {
    const existing = this.storage.findConsent(providerId, category);
    if (existing) {
      this.storage.deleteConsent(existing.id);
      this.logger.info('Consent revoked', { providerId, category });
    }
  }

  revokeAll(providerId: string): void {
    this.storage.deleteConsentsForProvider(providerId);
  }

  /** Append-only metadata record for a transfer that has just happened. */
  recordTransfer(entry: { providerHost: string; task: string; category: ConsentCategory; approxBytes: number }): void {
    const safeEntry: DataSentEntry = {
      ts: new Date().toISOString(),
      providerHost: entry.providerHost,
      task: entry.task,
      category: entry.category,
      approxBytes: Math.max(0, Math.round(entry.approxBytes)),
    };
    this.storage.appendDataSent(safeEntry);
  }

  overview(): PrivacyOverview {
    const providers = this.storage.listProviders();
    const byId = new Map(providers.map((p) => [p.id, p.name]));
    const settings = this.storage.getSettings();

    return {
      consents: this.storage.listConsents().map((consent) => ({
        ...consent,
        providerName: byId.get(consent.providerId),
      })),
      dataSent: this.storage.listDataSent(200),
      backgroundCalls: [
        {
          id: 'updates',
          label: 'Update check',
          // SPEC 15 §10: name the host. "Our release server" reads like a private
          // service the user has no way to look up, and it was not even accurate —
          // releases are published on GitHub.
          detail: 'Asks github.com whether a newer version of Clipwright exists. Sends no project data.',
          toggleKey: 'updateCheck',
          enabled: settings.privacy.updateCheck,
        },
        {
          id: 'ytdlp',
          label: 'yt-dlp update',
          detail: 'Asks github.com for a newer yt-dlp so link downloads keep working when sites change.',
          toggleKey: 'ytDlpUpdate',
          enabled: settings.privacy.ytDlpUpdate,
        },
        {
          id: 'downloads',
          label: 'Model downloads',
          detail: 'Downloads from huggingface.co, only when you press Download in the model manager.',
          toggleKey: null,
          enabled: null,
        },
        {
          id: 'ingest',
          label: 'URL downloads',
          detail: 'Fetches the site you paste into Import. Only happens for links you enter.',
          toggleKey: null,
          enabled: null,
        },
      ],
    };
  }

  clearLog(): number {
    return this.storage.clearDataSent();
  }

  /** CSV export — the same columns the Privacy list shows, nothing more. */
  toCsv(): string {
    const rows = this.storage.listDataSent(10_000);
    const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const header = 'time,provider host,task,data category,approximate bytes';
    return [header, ...rows.map((row) => [row.ts, row.providerHost, row.task, row.category, String(row.approxBytes)].map(escape).join(','))].join('\n');
  }

  categoryOfTask(task: string): ConsentCategory {
    if (task === 'transcription') return 'audio';
    if (task === 'connection_test') return 'test_payload';
    return 'transcript';
  }
}

export function newConsentId(): string {
  return uuidv7();
}
