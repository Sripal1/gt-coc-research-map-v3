import { svelte } from '@sveltejs/vite-plugin-svelte';
import * as fs from 'fs';
import * as path from 'path';
import { defineConfig } from 'vite';

const removeDataDir = () => {
  return {
    name: 'remove-data-dir',
    resolveId(source) {
      return source === 'virtual-module' ? source : null;
    },
    writeBundle(outputOptions, inputOptions) {
      const outDir = outputOptions.dir;
      const dataDir = path.resolve(outDir, 'data');
      fs.promises.rm(dataDir, { recursive: true }).then(() => {
        console.log(`Deleted ${dataDir}`)
      });
    }
  };
};

export default defineConfig(({ command, mode }) => {
  const baseConfig = { // Create a base config object
    plugins: [svelte()],
    build: {
      target: 'esnext' // Set target to esnext for all builds
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext' // Also set target for optimizeDeps
      }
    }
  };

  if (command === 'serve') {
    // Development
    return baseConfig; // Use the base config
  } else if (command === 'build') {
    switch (mode) {
      case 'production': {
        return {
          ...baseConfig, // Merge base config
          build: {
            ...baseConfig.build, // Merge base build config
            outDir: 'dist'
          }
        };
      }

      case 'github-private': {
        // Private repo: github page with subdirectory
        return {
          ...baseConfig,
          base: '/ai-map-private/gt-computing/',
          build: {
            ...baseConfig.build,
            outDir: 'gh-page'
          },
          plugins: [...baseConfig.plugins, removeDataDir()]
        };
      }

      case 'github': {
        // Production repo: github page at root
        return {
          ...baseConfig,
          base: '/ai-map/',
          build: {
            ...baseConfig.build,
            outDir: 'gh-page-prod'
          },
          plugins: [...baseConfig.plugins, removeDataDir()]
        };
      }

      case 'notebook': {
        // Production: notebook widget
        return {
          ...baseConfig, // Merge base config
          build: {
            ...baseConfig.build, // Merge base build config
            outDir: 'notebook-widget/_wizmap',
            sourcemap: false,
            lib: {
              entry: 'src/main.ts',
              formats: ['iife'],
              name: 'wizmap',
              fileName: format => 'wizmap.js'
            }
          },
          plugins: [
            svelte({
              emitCss: false
            }),
            {
              name: 'my-post-build-plugin',
              writeBundle: {
                sequential: true,
                order: 'post',
                handler(options) {
                  // Move target file to the notebook package
                  fs.copyFile(
                    path.resolve(options.dir, 'wizmap.js'),
                    path.resolve(__dirname, 'notebook-widget/wizmap/wizmap.js'),
                    error => {
                      if (error) throw error;
                    }
                  );

                  // Delete all other generated files
                  fs.promises.rm(options.dir, { recursive: true })
                    .catch(console.error);
                }
              }
            }
          ]
        };
      }

      case 'actions': {
        // GitHub Actions build: user-generated map with local data
        const basePath = process.env.VITE_BASE_PATH || '/';
        return {
          ...baseConfig,
          base: basePath,
          build: {
            ...baseConfig.build,
            outDir: 'dist'
          }
        };
      }

      default: {
        console.error(`Unknown production mode ${mode}`);
        return null;
      }
    }
  }
});
