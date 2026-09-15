import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import process from 'process'

/**
 * A relative base makes the build work wherever it lands: a GitHub Pages
 * project site under any repository name, a user site at the domain root,
 * Netlify, a subfolder, or dist/index.html opened straight off disk. Nothing
 * needs to know the repository name.
 *
 * BASE_PATH is still honoured if you want an absolute base, and is normalised
 * so that 'my-repo', '/my-repo' and '/my-repo/' all mean the same thing.
 */
const resolveBase = (raw) => {
  const value = (raw ?? '').trim()
  if (!value || value === '.' || value === './') return './'
  if (value === '/') return '/'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value.endsWith('/') ? value : value + '/'
  }
  const withLeadingSlash = value.startsWith('/') ? value : '/' + value
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : withLeadingSlash + '/'
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte(),
  ],
  base: resolveBase(process.env.BASE_PATH),
})
