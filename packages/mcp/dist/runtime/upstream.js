import path from "node:path";
function resolveHostPath(inputPath, projectDir) {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(projectDir, inputPath);
}
export function buildDockerRunArgs(upstream, projectDir = process.cwd()) {
    const args = ["run", "--rm", "-i", ...(upstream.containerArgs ?? [])];
    if (upstream.passWorkspace) {
        const workspaceMountPath = upstream.workspaceMountPath ?? "/workspace";
        args.push("-v", `${path.resolve(projectDir)}:${workspaceMountPath}`);
    }
    for (const mount of upstream.mounts ?? []) {
        const hostPath = resolveHostPath(mount.hostPath, projectDir);
        const mode = mount.readOnly ? ":ro" : "";
        args.push("-v", `${hostPath}:${mount.containerPath}${mode}`);
    }
    for (const [key, value] of Object.entries(upstream.env ?? {})) {
        args.push("-e", `${key}=${value}`);
    }
    if (upstream.containerCwd) {
        args.push("-w", upstream.containerCwd);
    }
    args.push(upstream.image);
    if (upstream.command) {
        args.push(upstream.command);
    }
    args.push(...upstream.args);
    return args;
}
export function buildUpstreamTransportConfig(upstream, projectDir = process.cwd()) {
    if (upstream.transport === "docker") {
        return {
            command: "docker",
            args: buildDockerRunArgs(upstream, projectDir)
        };
    }
    return {
        command: upstream.command,
        args: upstream.args,
        ...(upstream.env ? { env: upstream.env } : {}),
        ...(upstream.cwd ? { cwd: upstream.cwd } : {})
    };
}
