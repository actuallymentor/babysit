// The suite often runs inside a managed Babysit session, whose launcher
// exports BABYSIT_* (control id, bootstrap gate, docker flag, ...). Inherited,
// those make tests talk to the real control store or wait on gates that never
// open. PUSHOVER_* would make the auth checker fetch real usage and send real
// notifications. Drop them before any test file loads; tests set what they need.
// BABYSIT_RC_LOADED stops spawned CLIs from sourcing the real ~/.babysitrc.
for( const key of Object.keys( process.env ) ) if( /^(BABYSIT|PUSHOVER)_/.test( key ) ) delete process.env[ key ]
process.env.BABYSIT_RC_LOADED = `1`
