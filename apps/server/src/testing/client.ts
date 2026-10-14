/** Test helper: a minimal cookie-jar client around app.request(). */
export const TEST_ORIGIN = "http://localhost:5173";

interface Requester {
  request(path: string, init: RequestInit): Response | Promise<Response>;
}

export class TestClient {
  private cookies = new Map<string, string>();
  constructor(
    /** The app, or a getter for one created later (e.g. in beforeAll). */
    private readonly target: Requester | (() => Requester),
    private readonly ip = "10.0.0.1",
  ) {}

  private get app(): Requester {
    return typeof this.target === "function" ? this.target() : this.target;
  }

  async req(path: string, init: { method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Origin: TEST_ORIGIN, "x-forwarded-for": this.ip };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.app.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      this.cookies.set(k!, v.join("="));
    }
    return res;
  }

  async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
    const res = await this.req(path, init);
    return { status: res.status, body: (await res.json()) as T };
  }

  signUp(email: string, name: string) {
    return this.json("/api/auth/sign-up/email", { body: { email, name, password: "correct-horse-battery" } });
  }
}
