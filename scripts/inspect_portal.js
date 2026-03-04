const fs = require("fs");

async function main() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();
  const requests = [];

  page.on("request", async (request) => {
    const headers = request.headers();
    const entry = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: {
        "content-type": headers["content-type"] || "",
        "next-action": headers["next-action"] || "",
        "x-action": headers["x-action"] || "",
      },
      postData: request.postData() || "",
    };
    requests.push(entry);
  });

  page.on("response", async (response) => {
    if (!/coberturasalud\.msp\.gob\.ec/.test(response.url())) {
      return;
    }
    if (response.request().method() !== "POST") {
      return;
    }
    const record = requests.find((item) => item.url === response.url() && !item.response);
    if (!record) {
      return;
    }
    record.response = {
      status: response.status(),
      headers: await response.allHeaders(),
      bodyPreview: (await response.text()).slice(0, 3000),
    };
  });

  await page.goto("https://coberturasalud.msp.gob.ec/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);
  const inputSnapshot = await page.locator("input").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      placeholder: node.placeholder,
      value: node.value,
      ariaLabel: node.getAttribute("aria-label") || "",
      className: node.className,
    }))
  );
  console.log(JSON.stringify(inputSnapshot, null, 2));

  await page.locator("#cedula").fill("1712730132");
  const dateInput = page.locator("input[placeholder='DD-MM-YYYY']").first();
  await dateInput.fill("02-03-2026");
  await page.getByRole("button", { name: "Consultar" }).click();
  await page.waitForTimeout(8000);

  fs.writeFileSync("network_log.json", JSON.stringify(requests, null, 2), "utf8");
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
