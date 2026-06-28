type BrowserPage = {
  waitForFunction(
    pageFunction: (expected: string) => boolean,
    arg: string,
    options?: { timeout?: number },
  ): Promise<void>;
  locator(selector: string): { textContent(): Promise<string | null> };
  goto(url: string): Promise<unknown>;
  on(event: "pageerror", handler: (error: Error) => void): void;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
};

export type UiBrowserSmokeCheck = {
  readonly page: string;
  readonly check: string;
  readonly ok: boolean;
  readonly detail?: string;
};

export type UiBrowserSmokeResult = {
  readonly ok: boolean;
  readonly command: "ui-browser-smoke";
  readonly url: string;
  readonly checks: readonly UiBrowserSmokeCheck[];
  readonly jsErrors: readonly string[];
};

export type UiBrowserSmokeOptions = {
  readonly baseUrl: string;
  readonly runId: string;
  readonly headed?: boolean;
};

type StatusLineExpectation = "updated" | "refresh-off" | "error" | "listed";

async function waitForStatusLine(
  page: BrowserPage,
  expectation: StatusLineExpectation,
  timeoutMs = 10_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const text = document.getElementById("status-line")?.textContent ?? "";
      if (expected === "updated") {
        return text.includes("已更新");
      }
      if (expected === "refresh-off") {
        return text.includes("已关闭");
      }
      if (expected === "error") {
        return text.length > 0 && !text.includes("已更新");
      }
      return text.includes("共") || text.includes("已更新");
    },
    expectation,
    { timeout: timeoutMs },
  );
}

function recordCheck(
  checks: UiBrowserSmokeCheck[],
  page: string,
  check: string,
  ok: boolean,
  detail?: string,
): void {
  checks.push({ page, check, ok, detail });
}

async function assertTextContent(
  page: BrowserPage,
  selector: string,
  predicate: (text: string) => boolean,
): Promise<boolean> {
  const text = (await page.locator(selector).textContent()) ?? "";
  return predicate(text);
}

export async function runUiBrowserSmoke(
  options: UiBrowserSmokeOptions,
): Promise<UiBrowserSmokeResult> {
  const { chromium } = await import("playwright");
  const checks: UiBrowserSmokeCheck[] = [];
  const jsErrors: string[] = [];

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("pageerror", (error) => {
      jsErrors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") {
        return;
      }
      const text = message.text();
      if (text.includes("Failed to load resource")) {
        return;
      }
      jsErrors.push(text);
    });

    await page.goto(`${options.baseUrl}/ui/`);
    await waitForStatusLine(page, "updated");
    recordCheck(
      checks,
      "dashboard",
      "loads-metrics",
      await assertTextContent(page, "#metric-runs", (text) => text !== "—"),
    );
    recordCheck(
      checks,
      "dashboard",
      "shows-recent-run",
      (await page.locator("#recent-runs a").count()) > 0,
    );

    await page.locator("#auto-refresh").uncheck();
    await page.locator("#refresh-now").click();
    await waitForStatusLine(page, "refresh-off");
    recordCheck(checks, "dashboard", "auto-refresh-toggle", true);

    await page.goto(`${options.baseUrl}/ui/runs`);
    await waitForStatusLine(page, "listed");
    recordCheck(
      checks,
      "runs",
      "lists-seeded-run",
      (await page.locator("#runs-table a").count()) > 0,
    );

    await page.selectOption("#state-filter", "new");
    await page.waitForFunction(() => {
      const title = document.querySelector(".empty-cell-title");
      return title?.textContent === "没有匹配的 Run";
    });
    recordCheck(checks, "runs", "state-filter-empty", true);

    await page.goto(
      `${options.baseUrl}/ui/runs/${encodeURIComponent(options.runId)}`,
    );
    await waitForStatusLine(page, "updated");
    recordCheck(
      checks,
      "run-detail",
      "shows-run-title",
      await assertTextContent(page, "#run-title", (text) =>
        text.includes("octo/repo"),
      ),
    );
    recordCheck(
      checks,
      "run-detail",
      "shows-stale-alert",
      await page.locator("#stale-alert").isVisible(),
    );
    recordCheck(
      checks,
      "run-detail",
      "shows-timeline",
      (await page.locator("#timeline li").count()) > 0,
    );

    await page.goto(`${options.baseUrl}/ui/deliveries`);
    await waitForStatusLine(page, "listed");
    recordCheck(
      checks,
      "deliveries",
      "lists-seeded-delivery",
      (await page.locator("#deliveries-table tr").count()) > 0,
    );

    await page.selectOption("#delivery-status", "failed");
    await page.waitForFunction(() => {
      const title = document.querySelector(".empty-cell-title");
      return title?.textContent === "暂无 Webhook 投递";
    });
    recordCheck(checks, "deliveries", "status-filter-empty", true);

    await page.goto(
      `${options.baseUrl}/ui/runs/${encodeURIComponent("missing-run-id")}`,
    );
    await waitForStatusLine(page, "error");
    recordCheck(
      checks,
      "run-detail",
      "error-state",
      await assertTextContent(page, "#status-line", (text) =>
        text.includes("run not found"),
      ),
    );
  } finally {
    await browser.close();
  }

  return {
    ok: checks.every((check) => check.ok) && jsErrors.length === 0,
    command: "ui-browser-smoke",
    url: `${options.baseUrl}/ui/`,
    checks,
    jsErrors,
  };
}
