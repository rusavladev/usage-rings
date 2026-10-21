'use strict';
// Persists the account list. Tokens are encrypted with Electron's safeStorage
// (Windows DPAPI, tied to your Windows user) – they are never written in plain text.

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { DEFAULT_NOTIFY, normalizeNotify } = require('./notify-rules');

const defaultSettings = () => ({ pinned: false, refreshMin: 5, launchAtLogin: true, shape: 'circle', notify: normalizeNotify(DEFAULT_NOTIFY) });

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'accounts.json');
    this.accounts = []; // { id, provider, label, email, plan, color, shape, notify, tokens }
    this.selectedId = null;
    this.settings = defaultSettings();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.selectedId = raw.selectedId ?? null;
      this.settings = { ...this.settings, ...(raw.settings || {}) };
      this.settings.notify = normalizeNotify(this.settings.notify);
      this.accounts = (raw.accounts || [])
        .map((a) => {
          try {
            const tokens = JSON.parse(safeStorage.decryptString(Buffer.from(a.tokens, 'base64')));
            // shape + notifications are per profile; older files inherit the old global values
            return {
              id: a.id,
              provider: a.provider || 'claude',
              label: a.label,
              email: a.email,
              plan: a.plan,
              color: a.color,
              shape: a.shape || this.settings.shape || 'circle',
              notify: normalizeNotify(a.notify || this.settings.notify),
              tokens,
            };
          } catch {
            return null; // undecryptable (different Windows user / reset profile)
          }
        })
        .filter(Boolean);
    } catch {
      /* first run */
    }
  }

  save() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption is unavailable; refusing to store tokens in plain text.');
    }
    const data = {
      selectedId: this.selectedId,
      settings: this.settings,
      accounts: this.accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        color: a.color,
        shape: a.shape,
        notify: a.notify,
        label: a.label,
        email: a.email,
        plan: a.plan,
        tokens: safeStorage.encryptString(JSON.stringify(a.tokens)).toString('base64'),
      })),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
