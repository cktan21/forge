#!/bin/zsh
exec "${HOME}/.bun/bin/bun" run "${0:A:h}/script/kilocode/forge.ts" -- "${0:A:h}"
