import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig( {
    plugins: [
        react(),
        VitePWA( {
            injectRegister: null,
            registerType: `prompt`,
            manifest: {
                name: `Babysit Web`,
                short_name: `Babysit`,
                description: `A focused mobile interface for Babysit sessions`,
                start_url: `/`,
                display: `standalone`,
                background_color: `#f5f3ee`,
                theme_color: `#15221f`,
                icons: [
                    {
                        src: `/icon-192.png`,
                        sizes: `192x192`,
                        type: `image/png`,
                        purpose: `any`,
                    },
                    {
                        src: `/icon-512.png`,
                        sizes: `512x512`,
                        type: `image/png`,
                        purpose: `any maskable`,
                    },
                ],
            },
            workbox: {
                cleanupOutdatedCaches: true,
                navigateFallback: `/index.html`,
                navigateFallbackDenylist: [ /^\/api\//, /^\/healthz$/ ],
            },
        } ),
    ],
} )
