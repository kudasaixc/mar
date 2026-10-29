import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
async function exists(path) {
    return access(path).then(() => true, () => false);
}
/**
 * Discover verification commands for a project when none are configured:
 * package.json scripts (with the detected package manager), Cargo, Go, and pytest.
 */
export async function detectChecks(root) {
    const checks = {};
    try {
        const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        const runner = await exists(join(root, "pnpm-lock.yaml")) ? "pnpm"
            : await exists(join(root, "yarn.lock")) ? "yarn"
                : await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock")) ? "bun" : "npm";
        for (const name of ["test", "lint", "typecheck", "type-check", "check", "build"]) {
            const script = manifest.scripts?.[name];
            if (script && !/no test specified/.test(script))
                checks[name] = runner === "npm" && name === "test" ? "npm test" : `${runner} run ${name}`;
        }
    }
    catch {
        // No package.json or invalid JSON.
    }
    if (await exists(join(root, "Cargo.toml"))) {
        checks.test ??= "cargo test";
        checks.check ??= "cargo check";
    }
    if (await exists(join(root, "go.mod"))) {
        checks.test ??= "go test ./...";
        checks.vet ??= "go vet ./...";
    }
    if (await exists(join(root, "pytest.ini")) || await exists(join(root, "pyproject.toml")) || await exists(join(root, "setup.cfg"))) {
        checks.test ??= "python -m pytest -q";
    }
    return checks;
}
//# sourceMappingURL=checks.js.map