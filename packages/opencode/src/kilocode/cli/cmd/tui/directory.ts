import { KiloPtySelfCommand } from "@opencode-ai/core/kilocode/pty-self-command"

type Options = {
  model?: string
  agent?: string
  auto?: boolean
  yolo?: boolean
  "dangerously-skip-permissions"?: boolean
}

export function invocation(directory: string, options: Options, command = KiloPtySelfCommand.command()) {
  return [
    command.command,
    ...command.args,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.agent ? ["--agent", options.agent] : []),
    ...(options.auto || options.yolo || options["dangerously-skip-permissions"] ? ["--auto"] : []),
    "--",
    directory,
  ]
}

export function directorySwitch(options: Options) {
  const command = KiloPtySelfCommand.command()
  let target: string | undefined
  return {
    change: (directory: string) => {
      target = directory
    },
    finish() {
      if (!target) return
      const args = invocation(target, options, command)
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "KILO_ROUTE",
        ),
      )
      env.PWD = target
      // Run only after the renderer, plugins, and embedded worker have shut down.
      // A fresh process reloads project config and cannot inherit the previous chat.
      process.chdir(target)
      if (process.platform !== "win32" && process.execve) process.execve(command.command, args, env)
      const child = Bun.spawnSync(args, { cwd: target, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      process.exit(child.exitCode)
    },
  }
}
