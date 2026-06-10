const SESSION_KEY = "villamor-supabase-session";

export class SupabaseClient {
  constructor(url, publishableKey) {
    this.url = url.replace(/\/$/, "");
    this.publishableKey = publishableKey;
    this.session = this.readSession();
  }

  readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
    } catch {
      return null;
    }
  }

  saveSession(session) {
    this.session = session;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  async signIn(email, password) {
    const session = await this.authRequest("/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });
    this.saveSession(session);
    return session;
  }

  async signUp(email, password, displayName) {
    const result = await this.authRequest("/signup", {
      method: "POST",
      body: {
        email,
        password,
        data: { display_name: displayName },
      },
    });
    if (result.access_token) this.saveSession(result);
    return result;
  }

  async signOut() {
    if (this.session?.access_token) {
      await fetch(`${this.url}/auth/v1/logout`, {
        method: "POST",
        headers: this.headers(true),
      }).catch(() => null);
    }
    this.saveSession(null);
  }

  async refreshSession() {
    if (!this.session?.refresh_token) return null;
    const session = await this.authRequest("/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: this.session.refresh_token },
    });
    this.saveSession(session);
    return session;
  }

  async authRequest(path, { method, body }) {
    const response = await fetch(`${this.url}/auth/v1${path}`, {
      method,
      headers: {
        apikey: this.publishableKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.msg || payload.message || payload.error_description || "Falha na autenticação.");
    }
    return payload;
  }

  headers(authenticated = true, extra = {}) {
    return {
      apikey: this.publishableKey,
      ...(authenticated && this.session?.access_token
        ? { Authorization: `Bearer ${this.session.access_token}` }
        : {}),
      ...extra,
    };
  }

  async request(path, options = {}, retry = true) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...options,
      headers: this.headers(true, options.headers),
    });

    if (response.status === 401 && retry && this.session?.refresh_token) {
      await this.refreshSession();
      return this.request(path, options, false);
    }

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.message || payload?.details || `Erro Supabase ${response.status}.`);
    }
    return payload;
  }

  async selectAll(table, query = "select=*") {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request(`${table}?${query}`, {
        headers: { Range: `${offset}-${offset + pageSize - 1}` },
      });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async upsert(table, rows, onConflict) {
    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      await this.request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(rows.slice(index, index + chunkSize)),
      });
    }
  }

  async insert(table, row) {
    return this.request(table, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  }

  async delete(table, filter) {
    return this.request(`${table}?${filter}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
}
