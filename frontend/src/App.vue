<script setup>
import { ref, onMounted, computed, watch } from 'vue';
import axios from 'axios';
import { showToast, showSuccessToast, showFailToast, showConfirmDialog } from 'vant';
import CountUp from 'vue-countup-v3';

// ⚠️ 生产环境自动使用环境变量，本地开发使用 3000
const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000/api';

// --- 状态变量 ---
const isLoggedIn = ref(false); 
const currentUser = ref('');   
const authMode = ref('login'); 
const authForm = ref({ email: '', password: '', confirmPassword: '' });
const authLoading = ref(false);
const showMoney = ref(true); 

const list = ref([]);
const loading = ref(false);
const analysisTab = ref(0); // 0: 最赚, 1: 最亏

const showDialog = ref(false);
const showAction = ref(false);
const isEditMode = ref(false);
const currentItem = ref(null);
const form = ref({ code: '', cost: '', shares: '' });
const actions = [{ name: '修改持仓', color: '#1677ff' }, { name: '删除基金', color: '#ee0a24' }];
const listAnimationKey = ref(0);

// 排行榜相关状态
const showRankPopup = ref(false);
const rankList = ref([]);
const rankType = ref('day'); // 'day' or 'total'
const rankLoading = ref(false);

// --- 工具函数：格式化数字 (解决 +- 显示问题) ---
const formatNum = (num) => {
  const n = parseFloat(num);
  if (isNaN(n)) return '0.00';
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
};

// --- 认证相关逻辑 ---
const checkLogin = () => {
  const token = localStorage.getItem('token');
  const email = localStorage.getItem('user_email');
  if (token && email) {
    isLoggedIn.value = true;
    currentUser.value = email;
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    getList();
  }
};

const handleAuth = async () => {
  if (!authForm.value.email || !authForm.value.password) { showToast('账号密码不能为空'); return; }
  if (authMode.value === 'register' && authForm.value.password !== authForm.value.confirmPassword) { showFailToast('两次密码不一致'); return; }
  
  authLoading.value = true;
  const url = authMode.value === 'login' ? `${API_URL}/login` : `${API_URL}/register`;
  try {
    const res = await axios.post(url, { email: authForm.value.email, password: authForm.value.password });
    if (authMode.value === 'register') {
      showSuccessToast('注册成功'); authMode.value = 'login';
    } else {
      showSuccessToast('欢迎回来');
      const { token, email } = res.data;
      localStorage.setItem('token', token);
      localStorage.setItem('user_email', email);
      isLoggedIn.value = true; currentUser.value = email;
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      getList();
    }
  } catch (error) { showFailToast(error.response?.data?.message || '操作失败'); } finally { authLoading.value = false; }
};

const handleLogout = () => {
  showConfirmDialog({ title: '退出登录', message: '确定要退出当前账号吗？' }).then(() => {
    localStorage.removeItem('token'); localStorage.removeItem('user_email');
    isLoggedIn.value = false; list.value = [];
  }).catch(() => {});
};

const switchAuthMode = () => { authMode.value = authMode.value === 'login' ? 'register' : 'login'; };

// --- 业务逻辑 ---
const getList = async () => {
  loading.value = true;
  try {
    const res = await axios.get(`${API_URL}/holdings`);
    if (res.data.success) {
      list.value = res.data.data;
      listAnimationKey.value++; 
    }
  } catch (error) { showFailToast('获取数据失败'); } finally { loading.value = false; }
};

// 获取排行榜
const getLeaderboard = async () => {
  rankLoading.value = true;
  try {
    const res = await axios.get(`${API_URL}/leaderboard?type=${rankType.value}`);
    if (res.data.success) {
      rankList.value = res.data.data;
    }
  } catch (e) { showFailToast('加载榜单失败'); } finally { rankLoading.value = false; }
};

watch(rankType, () => { if (showRankPopup.value) getLeaderboard(); });
watch(showRankPopup, (val) => { if (val) getLeaderboard(); });

// 列表操作
const onCardClick = (item) => { currentItem.value = item; showAction.value = true; };
const onSelectAction = (action) => {
  showAction.value = false;
  if (action.name === '删除基金') handleDelete(currentItem.value);
  else if (action.name === '修改持仓') handleEdit(currentItem.value);
};
const handleDelete = (item) => {
  showConfirmDialog({ title: '确认删除' }).then(async () => {
    try { await axios.delete(`${API_URL}/delete/${item.id}`); showSuccessToast('删除成功'); getList(); } catch (e) { showFailToast('删除失败'); }
  }).catch(() => {});
};
const handleEdit = (item) => { isEditMode.value = true; form.value = { code: item.code, cost: item.cost, shares: item.shares }; showDialog.value = true; };
const handleAdd = () => { isEditMode.value = false; form.value = { code: '', cost: '', shares: '' }; showDialog.value = true; };
const onSubmit = async () => {
  if (!form.value.code) { showToast('请填写完整'); return; }
  try {
    const url = isEditMode.value ? `${API_URL}/update/${currentItem.value.id}` : `${API_URL}/add`;
    const method = isEditMode.value ? 'put' : 'post';
    await axios[method](url, { fundCode: form.value.code, cost: form.value.cost, shares: form.value.shares });
    showSuccessToast('操作成功'); showDialog.value = false; getList();
  } catch (error) { showFailToast('操作失败'); }
};

// 计算属性
const totalAsset = computed(() => list.value.reduce((sum, item) => sum + (item.market ? item.market.est_val : item.cost) * item.shares, 0));
const totalDayProfit = computed(() => list.value.reduce((sum, item) => sum + parseFloat(item.day_profit || 0), 0));
const totalDayProfitRate = computed(() => {
  if (totalAsset.value === 0) return 0;
  const yesterdayAsset = totalAsset.value - totalDayProfit.value;
  return yesterdayAsset > 0 ? ((totalDayProfit.value / yesterdayAsset) * 100).toFixed(2) : '0.00';
});
const topGainer = computed(() => { if (list.value.length === 0) return null; return [...list.value].sort((a, b) => parseFloat(b.day_profit) - parseFloat(a.day_profit))[0]; });
const topLoser = computed(() => { if (list.value.length === 0) return null; return [...list.value].sort((a, b) => parseFloat(a.day_profit) - parseFloat(b.day_profit))[0]; });

onMounted(() => { checkLogin(); });
</script>

<template>
  <div class="app-wrapper">
    <div v-if="!isLoggedIn" class="login-page">
      <div class="login-header">
        <div class="logo-box pulse-anim"><van-icon name="chart-trending-o" /></div>
        <h1 class="app-name">Fund Manager</h1>
      </div>
      <div class="login-body">
        <div class="form-title">{{ authMode === 'login' ? '账号登录' : '注册新账号' }}</div>
        <div class="input-group">
          <van-field v-model="authForm.email" placeholder="邮箱" left-icon="manager" class="custom-input" />
          <van-field v-model="authForm.password" type="password" placeholder="密码" left-icon="lock" class="custom-input" />
          <van-field v-if="authMode === 'register'" v-model="authForm.confirmPassword" type="password" placeholder="确认密码" left-icon="lock" class="custom-input" />
        </div>
        <van-button block round type="primary" color="linear-gradient(to right, #3b8eff, #1677ff)" @click="handleAuth">
          {{ authMode === 'login' ? '立即登录' : '立即注册' }}
        </van-button>
        <div class="switch-link" @click="switchAuthMode">
          <span>{{ authMode === 'login' ? '没有账号？' : '已有账号？' }}</span><span class="highlight">{{ authMode === 'login' ? '去注册' : '去登录' }}</span>
        </div>
      </div>
    </div>

    <div v-else class="main-page">
      
      <div class="header-bg">
        <div class="top-bar">
          <div class="user-chip" @click="handleLogout">
             <van-icon name="manager" class="u-icon" />
             <span class="u-name">{{ currentUser.split('@')[0] }}</span>
             <van-icon name="arrow-down" size="10" style="opacity: 0.6;" />
          </div>
          
          <div class="rank-chip" @click="showRankPopup = true">
             <van-icon name="medal-o" size="16" />
             <span>榜单</span>
          </div>
        </div>

        <div class="header-title-area">
          <div class="title-row">
            <span class="page-title">收益解读</span>
          </div>
          <div class="date-row">
            <span class="page-date">2月5日 周三</span>
            <span class="update-tag">数据已更新</span>
          </div>
        </div>
        
        <div class="header-illustration">
          <div class="float-card card-1"></div>
          <div class="float-card card-2"></div>
          <div class="float-arrow"><van-icon name="ascending" /></div>
        </div>
      </div>

      <div class="analysis-card slide-up-delay-1">
        <div class="card-top">
          <div class="card-label" @click="showMoney = !showMoney">
            当日收益(元) <van-icon :name="showMoney ? 'eye-o' : 'closed-eye'" />
          </div>
          <div class="big-money" :class="totalDayProfit >= 0 ? 'red-text' : 'green-text'">
            <span v-if="showMoney">
              <span v-if="totalDayProfit > 0">+</span>
              <count-up :end-val="totalDayProfit" :decimal-places="2" :duration="1.5"></count-up>
            </span>
            <span v-else>****</span>
            <span class="money-rate" v-if="showMoney">{{ totalDayProfit >= 0 ? '+' : '' }}{{ totalDayProfitRate }}%</span>
          </div>
        </div>
        <div class="asset-bar-box">
          <div class="bar-label"><span>基金资产</span><span>{{ showMoney ? totalAsset.toFixed(2) : '****' }}</span></div>
          <van-progress :percentage="100" stroke-width="8" color="#1677ff" track-color="#f0f2f5" :show-pivot="false" />
        </div>
      </div>

      <div class="rank-section slide-up-delay-2">
        <div class="rank-tabs">
          <div class="rank-tab" :class="{ active: analysisTab === 0 }" @click="analysisTab = 0">😇 最赚产品</div>
          <div class="rank-tab" :class="{ active: analysisTab === 1 }" @click="analysisTab = 1">😭 最亏产品</div>
        </div>
        <div class="rank-content">
          <div v-if="analysisTab === 0 && topGainer" class="rank-card" @click="onCardClick(topGainer)">
             <div class="rank-head"><span class="rank-name">{{ topGainer.name }}</span><span class="rank-tag">MVP</span></div>
             <div class="rank-data-row">
               <div class="r-item">
                 <div class="r-val" :class="parseFloat(topGainer.market?.est_rate) >= 0 ? 'red-text' : 'green-text'">
                   {{ formatNum(topGainer.market?.est_rate) }}%
                 </div>
                 <div class="r-lbl">今日涨幅</div>
               </div>
               <div class="r-item center">
                 <div class="r-val" :class="parseFloat(topGainer.day_profit) >= 0 ? 'red-text' : 'green-text'">
                   {{ formatNum(topGainer.day_profit) }}
                 </div>
                 <div class="r-lbl">今日盈利</div>
               </div>
               <div class="r-item right">
                  <div class="r-val" :class="parseFloat(topGainer.profit) >= 0 ? 'red-text' : 'green-text'">
                    {{ formatNum(topGainer.profit) }}
                  </div>
                  <div class="r-lbl">累计收益</div>
               </div>
             </div>
          </div>

          <div v-if="analysisTab === 1 && topLoser" class="rank-card" @click="onCardClick(topLoser)">
             <div class="rank-head"><span class="rank-name">{{ topLoser.name }}</span><span class="rank-tag gray">安慰</span></div>
             <div class="rank-data-row">
               <div class="r-item">
                 <div class="r-val" :class="parseFloat(topLoser.market?.est_rate) >= 0 ? 'red-text' : 'green-text'">
                   {{ formatNum(topLoser.market?.est_rate) }}%
                 </div>
                 <div class="r-lbl">今日跌幅</div>
               </div>
               <div class="r-item center">
                 <div class="r-val" :class="parseFloat(topLoser.day_profit) >= 0 ? 'red-text' : 'green-text'">
                   {{ formatNum(topLoser.day_profit) }}
                 </div>
                 <div class="r-lbl">今日亏损</div>
               </div>
               <div class="r-item right">
                  <div class="r-val" :class="parseFloat(topLoser.profit) >= 0 ? 'red-text' : 'green-text'">
                    {{ formatNum(topLoser.profit) }}
                  </div>
                  <div class="r-lbl">累计收益</div>
               </div>
             </div>
          </div>
          <div v-if="list.length === 0" class="empty-tip">暂无数据</div>
        </div>
      </div>

      <div class="list-section">
        <div class="list-header">持仓明细</div>
        <div class="fund-list" :key="listAnimationKey">
          <div v-for="(item, index) in list" :key="item.id" class="fund-card-item slide-in-right" :style="{ animationDelay: `${index * 0.1}s` }" @click="onCardClick(item)">
            <div class="row-left"><div class="fname">{{ item.name }}</div><div class="fcode">{{ item.code }}</div></div>
            <div class="row-mid"><div class="val-num">{{ item.market ? item.market.est_val : item.cost }}</div><div class="val-label">最新净值</div></div>
            <div class="row-right">
              <div class="rate-num" :class="item.market?.est_rate >= 0 ? 'red-text' : 'green-text'">
                {{ formatNum(item.market?.est_rate) }}%
              </div>
              <div class="profit-mini" :class="item.profit >= 0 ? 'red-text' : 'green-text'">
                {{ showMoney ? formatNum(item.profit) : '****' }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="fab-btn pulse-shadow" @click="handleAdd"><van-icon name="plus" /></div>

      <van-action-sheet v-model:show="showAction" :actions="actions" cancel-text="取消" @select="onSelectAction" />
      <van-dialog v-model:show="showDialog" :title="isEditMode ? '修改持仓' : '添加持仓'" show-cancel-button @confirm="onSubmit">
        <div class="form-box">
          <van-field v-model="form.code" label="基金代码" placeholder="001632" :disabled="isEditMode" />
          <van-field v-model="form.cost" label="持仓成本" type="number" />
          <van-field v-model="form.shares" label="持有份额" type="number" />
        </div>
      </van-dialog>

      <van-popup v-model:show="showRankPopup" position="bottom" round :style="{ height: '80%' }">
        <div class="rank-popup-content">
          <div class="popup-title">🏆 收益风云榜</div>
          <van-tabs v-model:active="rankType" name="rankType" animated color="#1677ff">
            <van-tab title="今日榜单" name="day"></van-tab>
            <van-tab title="总收益榜" name="total"></van-tab>
          </van-tabs>

          <div class="rank-list-box">
             <van-loading v-if="rankLoading" size="24px" vertical style="padding: 20px;">加载中...</van-loading>
             <div v-else-if="rankList.length === 0" class="empty-tip">暂无数据</div>
             
             <div v-else class="rank-user-row" v-for="(user, idx) in rankList" :key="idx">
               <div class="rank-idx">
                 <span v-if="idx === 0" style="font-size: 30px;">🥇</span>
                 <span v-else-if="idx === 1" style="font-size: 30px;">🥈</span>
                 <span v-else-if="idx === 2" style="font-size: 30px;">🥉</span>
                 <span v-else class="rank-num">{{ idx + 1 }}</span>
               </div>
               
               <div class="rank-user-info">
                 <div class="u-name">{{ user.nickname || '神秘用户' }}</div>
                 <div class="u-mail">{{ user.email }}</div>
               </div>
               
               <div class="rank-money" :class="(rankType === 'day' ? user.day_profit : user.total_profit) >= 0 ? 'red-text' : 'green-text'">
                 {{ formatNum(rankType === 'day' ? user.day_profit : user.total_profit) }}
               </div>
             </div>
          </div>
        </div>
      </van-popup>

    </div>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
:root { --ant-blue: #1677ff; --bg-gray: #f5f5f5; }
.app-wrapper { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background-color: var(--bg-gray); min-height: 100vh; }

/* --- 头部样式优化 --- */
.header-bg { 
  height: 170px; 
  background: radial-gradient(circle at 90% 10%, #4facfe 0%, #1677ff 80%); 
  padding: 16px 20px; 
  color: #fff; 
  position: relative; 
  overflow: hidden; 
  border-bottom-left-radius: 24px;
  border-bottom-right-radius: 24px;
}

/* 1. 顶部工具栏 */
.top-bar { display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 10; margin-bottom: 25px; }

/* 用户胶囊按钮 */
.user-chip { 
  background: rgba(255,255,255,0.15); 
  border: 1px solid rgba(255,255,255,0.2); 
  backdrop-filter: blur(4px); 
  padding: 6px 10px 6px 8px; 
  border-radius: 100px; 
  font-size: 13px; font-weight: 500; 
  display: flex; align-items: center; gap: 6px; 
  cursor: pointer; transition: all 0.2s;
}
.user-chip:active { background: rgba(255,255,255,0.3); transform: scale(0.98); }
.u-icon { background: #fff; color: #1677ff; border-radius: 50%; padding: 2px; font-size: 12px; }
.u-name { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 榜单胶囊按钮 */
.rank-chip { 
  background: rgba(255,255,255,0.15); 
  border: 1px solid rgba(255,255,255,0.2);
  backdrop-filter: blur(4px); 
  padding: 6px 14px; 
  border-radius: 100px; 
  font-size: 13px; font-weight: bold; 
  display: flex; align-items: center; gap: 4px; 
  cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.05);
}
.rank-chip:active { transform: scale(0.95); background: rgba(255,255,255,0.3); }

/* 2. 标题区域 */
.header-title-area { position: relative; z-index: 5; padding-left: 4px; }
.title-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.page-title { font-size: 26px; font-weight: 700; letter-spacing: 1px; text-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.date-row { display: flex; align-items: center; gap: 10px; font-size: 12px; opacity: 0.85; }
.update-tag { background: rgba(255,255,255,0.2); padding: 1px 6px; border-radius: 4px; font-size: 10px; }

/* 3. 插画 (下沉不挡字) */
.header-illustration { position: absolute; right: -10px; top: 60px; width: 140px; height: 120px; opacity: 0.8; z-index: 1; pointer-events: none; }
.float-card { position: absolute; background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.05) 100%); border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 12px; backdrop-filter: blur(2px); box-shadow: 0 8px 16px rgba(0,0,0,0.05); }

/* 微调卡片位置 */
.card-1 { width: 70px; height: 50px; top: 30px; right: 30px; transform: rotate(-10deg); animation: float 6s infinite ease-in-out; }
.card-2 { width: 50px; height: 50px; top: 60px; right: 70px; transform: rotate(15deg); background: rgba(255,255,255,0.15); animation: float 7s infinite 0.5s ease-in-out; }
.float-arrow { position: absolute; top: 20px; right: 60px; font-size: 48px; color: #fff; opacity: 0.9; transform: rotate(-10deg); filter: drop-shadow(0 4px 8px rgba(0,0,0,0.1)); animation: float 4s infinite ease-in-out; }

/* 通用部分 */
.analysis-card { background: #fff; margin: -50px 16px 16px 16px; border-radius: 16px; padding: 24px; box-shadow: 0 8px 20px rgba(0,0,0,0.06); position: relative; z-index: 10; }
.card-top { margin-bottom: 24px; }
.card-label { color: #666; font-size: 14px; display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.big-money { font-size: 36px; font-weight: bold; font-family: 'Roboto', sans-serif; }
.money-rate { font-size: 14px; font-weight: normal; opacity: 0.8; margin-left: 4px; }
.bar-label { display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-bottom: 6px; }

.rank-section { margin: 0 16px 20px 16px; }
.rank-tabs { display: flex; gap: 16px; margin-bottom: 12px; }
.rank-tab { background: #fff; padding: 8px 16px; border-radius: 20px; font-size: 14px; color: #666; cursor: pointer; }
.rank-tab.active { background: #e6f4ff; color: #1677ff; font-weight: bold; }
.rank-card { background: #fff; padding: 20px; border-radius: 16px; margin-bottom: 10px; }
.rank-head { display: flex; justify-content: space-between; margin-bottom: 16px; font-weight: bold; }
.rank-tag { background: #fff1f0; color: #f5222d; font-size: 10px; padding: 2px 6px; border-radius: 4px; }
.rank-tag.gray { background: #f5f5f5; color: #999; }
.rank-data-row { display: flex; justify-content: space-between; }
.r-val { font-size: 18px; font-weight: bold; margin-bottom: 4px; font-family: 'Roboto'; }
.r-lbl { font-size: 11px; color: #999; }

.list-section { padding: 0 16px 80px 16px; }
.list-header { font-size: 16px; font-weight: bold; margin-bottom: 12px; }
.fund-card-item { background: #fff; border-radius: 12px; margin-bottom: 12px; padding: 20px 16px; display: flex; justify-content: space-between; align-items: center; }
.fname { font-weight: 500; font-size: 16px; margin-bottom: 6px; }
.fcode, .val-label { font-size: 12px; color: #999; }
.val-num, .rate-num { font-weight: bold; font-family: 'Roboto'; }
.red-text { color: #e74c3c; }
.green-text { color: #1ba261; }

/* 悬浮按钮 + 呼吸动画 */
.fab-btn { 
  position: fixed; 
  bottom: 40px; 
  right: 20px; 
  width: 50px; 
  height: 50px; 
  background: #1677ff; 
  color: #fff; 
  border-radius: 50%; 
  display: flex; 
  align-items: center; 
  justify-content: center; 
  font-size: 24px; 
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.4); 
  z-index: 99; 
}

.pulse-shadow {
  animation: pulse-blue 2s infinite;
}

@keyframes pulse-blue {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(22, 119, 255, 0.7);
  }
  70% {
    transform: scale(1.05); /*稍微放大一点，效果更明显*/
    box-shadow: 0 0 0 10px rgba(22, 119, 255, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(22, 119, 255, 0);
  }
}

.form-box { padding: 20px 0; }
.login-page { position: fixed; top: 0; left: 0; width: 100%; height: 100vh; background: linear-gradient(135deg, #1677ff 0%, #0056b3 100%); display: flex; flex-direction: column; justify-content: flex-end; z-index: 1000; }
.login-header { position: absolute; top: 15%; width: 100%; text-align: center; color: #fff; }
.login-body { background: #fff; border-top-left-radius: 30px; border-top-right-radius: 30px; padding: 40px 30px; }
.input-group { margin-bottom: 30px; }
.custom-input { background: #f5f7fa; border-radius: 12px; margin-bottom: 16px; }

/* 榜单弹窗样式 */
.rank-popup-content { padding: 20px 0; height: 100%; display: flex; flex-direction: column; }
.popup-title { text-align: center; font-size: 18px; font-weight: bold; margin-bottom: 15px; }
.rank-list-box { flex: 1; overflow-y: auto; padding: 10px 20px; }
.rank-user-row { display: flex; align-items: center; padding: 15px 0; border-bottom: 1px solid #f5f5f5; }
.rank-idx { width: 40px; text-align: center; font-weight: bold; font-style: italic; color: #999; display: flex; justify-content: center; }
.rank-num { font-size: 18px; font-family: 'Roboto', sans-serif; }
.rank-user-info { flex: 1; margin-left: 10px; }
.u-name { font-size: 15px; font-weight: 500; color: #333; }
.u-mail { font-size: 12px; color: #999; }
.rank-money { font-size: 16px; font-weight: bold; font-family: 'Roboto', sans-serif; }
.empty-tip { text-align: center; color: #999; padding: 20px; font-size: 13px; }

@keyframes float { 0%, 100% { transform: translateY(0) rotate(-10deg); } 50% { transform: translateY(-8px) rotate(-10deg); } }
.pulse-anim { animation: float 3s infinite; }
</style>