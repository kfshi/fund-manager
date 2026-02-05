import { createApp } from 'vue'
import App from './App.vue'
import Vant from 'vant'; // 引入组件库
import 'vant/lib/index.css'; // 引入样式

const app = createApp(App);
app.use(Vant);
app.mount('#app');