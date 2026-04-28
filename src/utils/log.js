import { log as mentie_log } from 'mentie'

// Re-export mentie log with babysit prefix
mentie_log.prefix = `babysit`

export const log = mentie_log
