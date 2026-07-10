import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import qrcode from "qrcode-terminal";
import { openDb, createEnrollToken } from "./db.js";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(serverDir, ".env");

function printEnrollLink(base?: string) {
  const db = openDb();
  const { token, expiresAt } = createEnrollToken(db);
  const resolvedBase = (
    base ?? process.env.DASHBOARD_URL ?? `http://localhost:${process.env.PORT ?? 8787}`
  ).replace(/\/$/, "");
  const url = `${resolvedBase}/?enroll=${token}`;
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);

  console.log("\npasskey enrollment link (single use, expires in %d minutes):\n", minutes);
  console.log(`  ${url}\n`);
  qrcode.generate(url, { small: true });
}

/**
 * The enrollment link needs a running server (and, without a production build, the
 * vite dev server too). Start whatever is missing, wait for the API, then mint.
 */
async function startServerAndEnroll(port: string, dashboardUrl: string) {
  const children: ChildProcess[] = [];
  const apiUrl = `http://localhost:${port}/api/session`;

  // "ours" = the session endpoint answers with its expected shape. Any other
  // response means a different process owns the port (loopback hijack included).
  const probe = async (): Promise<"ours" | "other" | "none"> => {
    try {
      const res = await fetch(apiUrl);
      const body = await res.json().catch(() => null);
      return res.ok && body && "authenticated" in body ? "ours" : "other";
    } catch {
      return "none";
    }
  };

  const initial = await probe();
  if (initial === "other") {
    console.error(
      `something else is answering on localhost:${port} — pick a different PORT in .env and rerun`,
    );
    return;
  }

  if (initial === "none") {
    const logs: string[] = [];
    const capture = (child: ChildProcess) => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => {
          logs.push(...chunk.toString().split("\n").filter(Boolean));
          if (logs.length > 30) logs.splice(0, logs.length - 30);
        });
      }
      return child;
    };
    const built =
      existsSync(path.join(serverDir, "dist/index.js")) &&
      existsSync(path.join(serverDir, "../web/dist/index.html"));
    const opts = { stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[] };
    if (built) {
      children.push(capture(spawn("node", ["dist/index.js"], { cwd: serverDir, ...opts })));
    } else {
      children.push(capture(spawn("npx", ["tsx", "src/index.ts"], { cwd: serverDir, ...opts })));
      children.push(
        capture(spawn("npm", ["run", "dev"], { cwd: path.join(serverDir, "../web"), ...opts })),
      );
    }
    process.stdout.write("starting the server");
    const deadline = Date.now() + 30_000;
    let state: "ours" | "other" | "none" = "none";
    while (Date.now() < deadline) {
      state = await probe();
      if (state !== "none") break;
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("");
    if (state !== "ours") {
      for (const c of children) c.kill();
      console.error("server didn't come up within 30s. last output:\n");
      for (const line of logs.slice(-15)) console.error(`  ${line}`);
      console.error("\nstart it yourself, then: npm run enroll");
      return;
    }
  }

  printEnrollLink(dashboardUrl);

  if (children.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\npress enter when you've enrolled (stops the temporary server): ");
    rl.close();
    for (const c of children) c.kill();
    console.log("done. start the server normally with npm run dev (or npm start).");
  }
}

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // buffer lines ourselves: readline drops input that arrives between questions,
  // which breaks piped/scripted runs
  const buffered: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiting.length > 0) waiting.shift()!("");
  });
  const readAnswer = (): Promise<string> => {
    const line = buffered.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.resolve("");
    return new Promise((resolve) => waiting.push(resolve));
  };
  // prompts go through readline's own prompt state so line refreshes
  // (backspace, arrows) redraw correctly
  const ask = async (q: string, fallback = ""): Promise<string> => {
    rl.setPrompt(fallback ? `${q} [${fallback}]: ` : `${q}: `);
    rl.prompt();
    const answer = (await readAnswer()).trim();
    return answer || fallback;
  };
  // sudo-style hidden prompt: mute stdout while the secret is typed, so
  // readline's echo goes nowhere (readline/promises has no _writeToOutput hook)
  const askHidden = async (q: string): Promise<string> => {
    rl.setPrompt(`${q}: `);
    rl.prompt();
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = () => true;
    try {
      return (await readAnswer()).trim();
    } finally {
      (process.stdout as { write: unknown }).write = originalWrite;
      originalWrite("\n");
    }
  };

  console.log("pds operator setup\n");

  if (existsSync(envPath)) {
    const overwrite = await ask(`${envPath} exists, overwrite? (y/N)`, "n");
    if (overwrite.toLowerCase() !== "y") {
      rl.close();
      console.log("leaving .env alone.");
      return;
    }
  }

  const pdsHostname = await ask("pds hostname (e.g. pds.example.com)");
  const pdsAdminPassword = await askHidden("pds admin password");
  const relayHostname = await ask("relay hostname", "bsky.network");
  const appviewUrl = await ask("appview url for profile links", "https://bsky.app");
  const dashboardUrl = await ask("dashboard url (used in DM deep links)", "http://localhost:5173");
  const port = await ask("api port", "8787");

  console.log("\noperator password is optional. leave empty for passkey-only sign-in");
  console.log("(recovery is shell access: npm run enroll mints a new passkey link).");
  const operatorPassword = await askHidden("operator password (empty for passkey-only)");

  console.log("\nflag alerts via bluesky dm. leave the handle empty to skip.");
  const notifyHandle = await ask("sender handle (needs an app password with DM access)");
  let notifyAppPassword = "";
  let notifyRecipient = "";
  if (notifyHandle) {
    notifyAppPassword = await askHidden("sender app password");
    notifyRecipient = await ask("recipient handle");
  }

  const lines = [
    `PDS_HOSTNAME=${pdsHostname}`,
    `PDS_ADMIN_PASSWORD=${pdsAdminPassword}`,
    `RELAY_HOSTNAME=${relayHostname}`,
    operatorPassword
      ? `OPERATOR_PASSWORD_HASH=${bcrypt.hashSync(operatorPassword, 10)}`
      : `# passkey-only: no OPERATOR_PASSWORD_HASH`,
    `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    `PORT=${port}`,
    `APPVIEW_URL=${appviewUrl}`,
    `DASHBOARD_URL=${dashboardUrl}`,
    `NOTIFY_HANDLE=${notifyHandle}`,
    `NOTIFY_APP_PASSWORD=${notifyAppPassword}`,
    `NOTIFY_RECIPIENT=${notifyRecipient}`,
    "",
  ];
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  console.log(`\nwrote ${envPath}`);
  console.log("labelers: copy labelers.json.example to labelers.json and edit the watchlist.");

  const flyToml = path.join(serverDir, "../fly.toml");
  let flyGenerated = false;
  const wantFly = (await ask("\ngenerate fly.toml for deploying to fly.io? (y/N)", "n"))
    .toLowerCase();
  if (wantFly === "y" && (!existsSync(flyToml) ||
      (await ask(`${flyToml} exists, overwrite? (y/N)`, "n")).toLowerCase() === "y")) {
    flyGenerated = true;
    const appName = await ask("fly app name", "pds-operator");
    const region = await ask("fly region", "iad");
    const flyUrl = await ask("public dashboard url", `https://${appName}.fly.dev`);

    writeFileSync(
      flyToml,
      `app = "${appName}"
primary_region = "${region}"

[build]

[env]
  HOST = "0.0.0.0"
  PORT = "8787"
  PDS_HOSTNAME = "${pdsHostname}"
  RELAY_HOSTNAME = "${relayHostname}"
  APPVIEW_URL = "${appviewUrl}"
  DASHBOARD_URL = "${flyUrl.replace(/\/$/, "")}"
  DB_PATH = "/data/data.sqlite"
  AUDIT_LOG_PATH = "/data/audit.log"

[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 8787
  force_https = true
  # the syncer's streams and DM alerts need the machine always on
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`,
    );
    console.log(`\nwrote ${flyToml}. deploy steps:\n`);
    const secrets = [
      `PDS_ADMIN_PASSWORD=${pdsAdminPassword}`,
      `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
      ...(operatorPassword
        ? [`OPERATOR_PASSWORD_HASH=${bcrypt.hashSync(operatorPassword, 10)}`]
        : []),
      ...(notifyHandle
        ? [
            `NOTIFY_HANDLE=${notifyHandle}`,
            `NOTIFY_APP_PASSWORD=${notifyAppPassword}`,
            `NOTIFY_RECIPIENT=${notifyRecipient}`,
          ]
        : []),
    ];
    console.log(`  fly apps create ${appName}`);
    console.log(`  fly volumes create data -a ${appName} --region ${region} --size 1 --yes`);
    console.log(`  fly secrets set -a ${appName} --stage <values from your answers>`);
    console.log("  fly deploy --remote-only");
    console.log(`  fly ssh console -a ${appName} -C "node dist/cli.js enroll"   # passkey`);

    const deployNow = (await ask("\nrun these now? (y/N)", "n")).toLowerCase();
    if (deployNow === "y") {
      const repoRoot = path.join(serverDir, "..");
      const run = (args: string[]) =>
        new Promise<number>((resolve) => {
          console.log(`\n$ fly ${args.join(" ").slice(0, 80)}${args.join(" ").length > 80 ? " …" : ""}`);
          const child = spawn("fly", args, { stdio: "inherit", cwd: repoRoot });
          child.on("error", () => resolve(127));
          child.on("exit", (code) => resolve(code ?? 1));
        });

      if ((await run(["version"])) !== 0) {
        console.error("\nflyctl not found — install it (https://fly.io/docs/flyctl/install/),");
        console.error("sign in with `fly auth login`, then run the steps above.");
      } else {
        // create/volume may already exist on a rerun — carry on
        await run(["apps", "create", appName]);
        await run(["volumes", "create", "data", "-a", appName, "--region", region, "--size", "1", "--yes"]);
        const staged = await run(["secrets", "set", "-a", appName, "--stage", ...secrets]);
        const deployed = staged === 0 ? await run(["deploy", "--remote-only"]) : 1;
        if (deployed === 0) {
          console.log("\ndeployed. minting a passkey enrollment link on the fly machine:");
          await run(["ssh", "console", "-a", appName, "-C", "node dist/cli.js enroll"]);
          console.log(`\nopen the link above to enroll. your dashboard: ${flyUrl}`);
        } else {
          console.error("\ndeploy didn't finish — fix the error above and rerun the steps.");
        }
      }
    }
  }

  if (flyGenerated) {
    // a locally minted token lands in the local sqlite and passkeys bind to the
    // local hostname — for fly, enrollment has to happen on the deployed machine
    rl.close();
    return;
  }

  const enrollNow = (
    await ask("\nstart the server and mint a passkey enrollment link? (y/N)", "n")
  ).toLowerCase();
  rl.close();
  if (enrollNow === "y") await startServerAndEnroll(port, dashboardUrl);
  else console.log("\nlater: npm run enroll (with the server running)");
}

const command = process.argv[2];
if (command === "setup") {
  await setup();
} else if (command === "enroll") {
  printEnrollLink();
  console.log("\nthe server has to be running for the link to work.");
} else {
  console.log("usage: cli <setup|enroll>");
  process.exit(1);
}
