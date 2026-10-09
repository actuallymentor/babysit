// The suite often runs inside a managed Babysit session, whose launcher
// exports BABYSIT_* (control id, bootstrap gate, docker flag, ...). Inherited,
// those make tests talk to the real control store or wait on gates that never
// open. Drop them before any test file loads; tests set what they need.
for( const key of Object.keys( process.env ) ) if( key.startsWith( `BABYSIT_` ) ) delete process.env[ key ]
