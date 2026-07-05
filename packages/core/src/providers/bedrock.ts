/**
 * Amazon Bedrock support. Zero-login like ollama: credentials come from the
 * standard AWS chain (env → shared config → SSO → IMDS) — exactly what the
 * aws CLI writes — so a machine that's `aws configure`d / `aws sso login`ed
 * just works, no key stored in loop's auth store. The model list is what the
 * ACCOUNT can actually invoke in the region (foundation models + cross-region
 * inference profiles), not a hardcoded table.
 */
import { brandEnv } from "../brand";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function awsCredentialsFile(): string {
    return process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials");
}

function awsConfigFile(): string {
    return process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
}

/**
 * Cheap sync check: does this machine have ANY standard AWS credential source
 * (env keys, a Bedrock bearer token, a profile, or aws-cli config files)?
 * Gates the real credential-chain resolution so machines with no AWS setup
 * never pay for it.
 */
export function hasAwsCredentialSources(): boolean {
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_PROFILE) return true;
    return existsSync(awsCredentialsFile()) || existsSync(awsConfigFile());
}

/** `region` of the active profile in ~/.aws/config, if present. */
function awsConfigFileRegion(): string | undefined {
    try {
        const profile = process.env.AWS_PROFILE || "default";
        let inSection = false;
        for (const raw of readFileSync(awsConfigFile(), "utf8").split("\n")) {
            const line = raw.trim();
            if (line.startsWith("[")) {
                inSection = line === `[${profile === "default" ? "default" : `profile ${profile}`}]`;
                continue;
            }
            if (!inSection) continue;
            const m = line.match(/^region\s*=\s*(\S+)/);
            if (m) return m[1];
        }
    } catch {
        // unreadable config — fall through to the default
    }
    return undefined;
}

export function bedrockRegion(): string {
    return (
        brandEnv("BEDROCK_REGION") ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        awsConfigFileRegion() ||
        "us-east-1"
    );
}

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

/**
 * Resolve credentials from the aws CLI's local sources: env vars, then the
 * shared config/credentials files (profiles, SSO, credential_process, assumed
 * roles). Deliberately NOT the full node chain — its IMDS/ECS hops burn ~5s of
 * connect timeouts on a laptop that has an ~/.aws dir but no usable profile,
 * and machines with ONLY instance-role creds don't pass the source gate above
 * anyway. Model calls (getModel) still use the full chain, so on EC2 an
 * instance role keeps working for inference. Null (never a throw) when
 * nothing resolves — not configured, expired SSO — or past the timeout.
 */
export async function resolveAwsCredentials(timeoutMs = 5_000): Promise<AwsCredentials | null> {
    if (!hasAwsCredentialSources()) return null;
    try {
        const { fromEnv, fromIni } = await import("@aws-sdk/credential-providers");
        const timeout = new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), timeoutMs);
            t.unref?.();
        });
        const localChain = async () => {
            try {
                return await fromEnv()();
            } catch {
                return fromIni()();
            }
        };
        const creds = await Promise.race([localChain(), timeout]);
        if (!creds?.accessKeyId || !creds.secretAccessKey) return null;
        return {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
        };
    } catch {
        return null;
    }
}

export interface BedrockModelSummary {
    /** Invokable id — a foundation-model id or a cross-region inference-profile id. */
    id: string;
    name: string;
}

interface FoundationModelSummary {
    modelId?: string;
    modelName?: string;
    outputModalities?: string[];
    inferenceTypesSupported?: string[];
    responseStreamingSupported?: boolean;
    modelLifecycle?: { status?: string };
}

/**
 * Lists what this account can invoke in the region: cross-region inference
 * profiles (`us.`/`eu.`/… ids — the only invokable form for newer models)
 * plus foundation models still offered on-demand under their bare id. Null
 * when credentials don't resolve or the Bedrock control plane rejects us
 * (no access / wrong region).
 */
export async function listBedrockModels(): Promise<BedrockModelSummary[] | null> {
    const creds = await resolveAwsCredentials();
    if (!creds) return null;
    const region = bedrockRegion();
    const { AwsClient } = await import("aws4fetch");
    const aws = new AwsClient({ ...creds, region, service: "bedrock" });
    const base = `https://bedrock.${region}.amazonaws.com`;
    try {
        const [fmRes, ipRes] = await Promise.all([
            aws.fetch(`${base}/foundation-models`, { signal: AbortSignal.timeout(10_000) }),
            aws.fetch(`${base}/inference-profiles?maxResults=1000`, { signal: AbortSignal.timeout(10_000) }),
        ]);
        if (!fmRes.ok) return null;
        const fmBody = (await fmRes.json()) as { modelSummaries?: FoundationModelSummary[] };
        // Streaming text models only — loop drives everything through streamText.
        const foundation = (fmBody.modelSummaries ?? []).filter(
            (m) =>
                m.modelId &&
                (m.modelLifecycle?.status ?? "ACTIVE") === "ACTIVE" &&
                (m.outputModalities ?? ["TEXT"]).includes("TEXT") &&
                m.responseStreamingSupported !== false,
        );
        const byId = new Map(foundation.map((m) => [m.modelId!, m]));
        const allIds = new Set((fmBody.modelSummaries ?? []).map((m) => m.modelId));

        const out: BedrockModelSummary[] = [];
        const covered = new Set<string>();
        if (ipRes.ok) {
            const ipBody = (await ipRes.json()) as {
                inferenceProfileSummaries?: Array<{
                    inferenceProfileId?: string;
                    inferenceProfileName?: string;
                    status?: string;
                    models?: Array<{ modelArn?: string }>;
                }>;
            };
            for (const p of ipBody.inferenceProfileSummaries ?? []) {
                if (!p.inferenceProfileId || p.status !== "ACTIVE") continue;
                // Text-only gate via the underlying foundation model: skip the
                // profile when its model is listed here but failed the text/
                // streaming filter; keep profiles we can't cross-check.
                const underlying = p.models?.map((m) => m.modelArn?.split("/").pop()).find(Boolean);
                if (underlying && allIds.has(underlying) && !byId.has(underlying)) continue;
                out.push({ id: p.inferenceProfileId, name: p.inferenceProfileName ?? p.inferenceProfileId });
                covered.add(p.inferenceProfileId);
                if (underlying) covered.add(underlying);
            }
        }
        // Bare on-demand models a profile doesn't already cover (older families).
        for (const m of foundation) {
            if (covered.has(m.modelId!)) continue;
            if (!(m.inferenceTypesSupported ?? []).includes("ON_DEMAND")) continue;
            out.push({ id: m.modelId!, name: m.modelName ?? m.modelId! });
        }
        return out;
    } catch {
        return null;
    }
}

/** Geo prefixes used by cross-region inference-profile ids. */
const BEDROCK_GEO_PREFIXES = new Set(["us", "eu", "apac", "jp", "au", "ca", "sa", "global", "us-gov"]);

/**
 * Reduce a bedrock model/profile id to the vendor's bare model id so pricing/
 * context can be inherited from the known catalog:
 * "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5-20250929".
 */
export function bedrockShortModelId(id: string): string {
    const parts = id.split(".");
    while (parts.length > 1 && BEDROCK_GEO_PREFIXES.has(parts[0])) parts.shift();
    if (parts.length > 1) parts.shift(); // vendor segment (anthropic./meta./…)
    return parts
        .join(".")
        .replace(/-v\d+(:.*)?$/, "")
        .replace(/:.*$/, "");
}
