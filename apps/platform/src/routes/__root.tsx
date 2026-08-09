import { Outlet, createRootRoute } from '@tanstack/react-router'

import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { AuroraBackground } from '#/components/layout/aurora-background'

import '../styles.css'

export const Route = createRootRoute({
  component: RootComponent,
})

/**
 * Root owns the ambient aurora so auth ↔ chat never remounts blobs
 * (avoids the full-page “blink” when the canvas re-seeds).
 */
function RootComponent() {
  return (
    <>
      <AuroraBackground />
      <Outlet />
      <TanStackDevtools
        config={{
          position: 'bottom-right',
        }}
        plugins={[
          {
            name: 'TanStack Router',
            render: <TanStackRouterDevtoolsPanel />,
          },
        ]}
      />
    </>
  )
}
