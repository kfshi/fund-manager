import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0', // <--- 关键点：允许外部访问
    port: 5173,      // <--- 关键点：固定端口
    strictPort: true,
  }
})