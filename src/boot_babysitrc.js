// Imported first by the CLI entry: import-time constants (BABYSIT_HOME,
// BABYSIT_TMUX_SOCKET, ...) must see ~/.babysitrc before their modules load.
import { load_babysitrc } from './utils/babysitrc.js'

load_babysitrc()
