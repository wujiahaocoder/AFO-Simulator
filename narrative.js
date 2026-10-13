/* Narrative integration for the classic, offline game.
 * Content is compiled separately; this file owns scheduling, evidence and final choices.
 */
"use strict";
const narrativeData = window.AFONarrative;
const subjectNames = { chinese: '语文', math: '数学', english: '英语', physics: '物理', chemistry: '化学', biology: '生物' };
const relationshipNames = { teacher: '班主任', mathTeacher: '数学老师', chineseTeacher: '语文老师', englishTeacher: '英语老师', classmateA: '同桌', classmateB: '旧队友', parents: '父母', crush: '校园记录同学' };
const effectNames = { ...subjectNames, ...relationshipNames, energy: '精力', stress: '压力', health: '健康', mental: '心理', anxiety: '焦虑', money: '金钱' };
const saveKey = 'afo-save-3.0.0';
const legacy = { initGame, updateUI, study, rest, exercise, takeExam, homework, activity, economy, changeWeather, checkAchievements, openModal };
let actionInProgress = null;
let saveAvailable = true;

Object.assign(gameState, {
    daysLeft: 364, completedWeeks: 0, phase: 'playing',
    narrativeQueue: [], activeNarrative: null, narrativeFeedback: null,
    storyChoices: {}, memoryChoices: {}, actionHistory: [], examHistory: [],
    randomSeen: [], randomCountThisWeek: 0, lastNegativeWeek: {},
    deferredRandom: false, weekRandomAttempted: false, weekEnding: false,
    goalWeek: 5, goalResults: {}, totalHomework: 0, totalIncome: 0,
    lowStressWeeks: 0, highEnergyWeeks: 0, finalSnapshot: null, finalRoute: null,
    romance: '暂不命名', mutualAffirmation: false, previousWeather: null,
    oldProgramAccess: false, practiceGoal: null, logHistory: [], negativeRandomThisWeek: false,
    reviewedExams: [], reviewPlan: null, studyGroupWeek: null, totalReviews: 0, totalStudyGroups: 0
});
const initialState = JSON.parse(JSON.stringify(gameState));

function escapeText(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function paragraphs(text) {
    return String(text).split(/\n\s*\n/).filter(Boolean).map(p => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
}
function clampState() {
    for (const key of ['energy', 'stress', 'health', 'mental', 'anxiety']) gameState[key] = Math.max(0, Math.min(100, gameState[key]));
    for (const group of ['subjects', 'relationships']) {
        for (const key in gameState[group]) gameState[group][key] = Math.max(0, Math.min(100, gameState[group][key]));
    }
    gameState.money = Math.max(0, gameState.money);
}
function validateEffect(effect) {
    for (const [key, value] of Object.entries(effect || {})) {
        if (key === 'subjects') {
            for (const [subject, amount] of Object.entries(value)) {
                if (subject !== 'all' && !Object.hasOwn(subjectNames, subject)) throw new Error(`未知学科效果：${subject}`);
                if (!Number.isFinite(amount)) throw new Error('无效学科增益');
            }
        } else if (!Object.hasOwn(effectNames, key) || !Number.isFinite(value)) {
            throw new Error(`未知或无效效果：${key}`);
        }
    }
}
function applyEffect(effect) {
    validateEffect(effect);
    if (gameState.finalSnapshot) return false;
    if ((effect.money || 0) < -gameState.money) return false;
    for (const [key, value] of Object.entries(effect)) {
        if (key === 'subjects') {
            for (const [subject, amount] of Object.entries(value)) {
                const targets = subject === 'all' ? Object.keys(subjectNames) : [subject];
                for (const target of targets) gameState.subjects[target] += amount;
            }
        } else if (Object.hasOwn(subjectNames, key)) gameState.subjects[key] += value;
        else if (Object.hasOwn(relationshipNames, key)) gameState.relationships[key] += value;
        else gameState[key] += value;
    }
    clampState();
    return true;
};
function previewEffect(effect) {
    const parts = [];
    for (const [key, value] of Object.entries(effect || {})) {
        if (key === 'subjects') {
            for (const [subject, amount] of Object.entries(value)) parts.push(`${subject === 'all' ? '六科各' : subjectNames[subject]} ${amount >= 0 ? '+' : ''}${amount}`);
        } else parts.push(`${effectNames[key]} ${value >= 0 ? '+' : ''}${value}${key === 'money' ? '元' : ''}`);
    }
    return parts.join('，') || '仅保留这次选择与记录';
}
function saveGame() {
    try {
        const state = { ...gameState, achievements: [...gameState.achievements], currentGoal: null };
        localStorage.setItem(saveKey, JSON.stringify({ version: '3.0.1', state }));
        saveAvailable = true;
        return true;
    } catch (_) {
        saveAvailable = false;
        return false;
    }
}
function restoreGame() {
    try {
        const saved = JSON.parse(localStorage.getItem(saveKey) || 'null');
        if (!saved || !['3.0.0', '3.0.1'].includes(saved.version)) return false;
        const s = saved.state;
        if (!s || !Number.isInteger(s.week) || s.week < 1 || s.week > 52 ||
            !['playing', 'postExam', 'ending'].includes(s.phase) ||
            !['actionHistory', 'examHistory', 'narrativeQueue', 'events', 'randomSeen', 'achievements', 'logHistory'].every(k => Array.isArray(s[k])) ||
            !Number.isInteger(s.actionsThisWeek) || s.actionsThisWeek < 0 || s.actionsThisWeek > 3 ||
            !['energy', 'stress', 'health', 'mental', 'anxiety', 'money'].every(k => Number.isFinite(s[k])) ||
            !Object.keys(subjectNames).every(k => Number.isFinite(s.subjects?.[k])) ||
            !Object.keys(relationshipNames).every(k => Number.isFinite(s.relationships?.[k]))) return false;
        if ([...s.narrativeQueue, ...(s.activeNarrative ? [s.activeNarrative] : [])].some(id => !findNarrative(id))) return false;
        if (s.phase !== 'playing' && (!s.finalSnapshot || !Number.isInteger(s.finalSnapshot.score) ||
            s.finalSnapshot.score < 0 || s.finalSnapshot.score > 100 ||
            !Object.keys(subjectNames).every(k => Number.isFinite(s.finalSnapshot.subjects?.[k])))) return false;
        if (s.phase === 'ending' && !['C01', 'C02', 'C03', 'C04'].includes(s.finalRoute)) return false;
        const fresh = JSON.parse(JSON.stringify(initialState));
        const restoredAchievements = new Set(s.achievements);
        Object.assign(gameState, fresh, s, { achievements: restoredAchievements });
        gameState.reviewedExams = Array.isArray(gameState.reviewedExams) ? gameState.reviewedExams : [];
        if (gameState.reviewPlan && (!Array.isArray(gameState.reviewPlan.subjects) ||
            !gameState.reviewPlan.subjects.every(k => Object.hasOwn(subjectNames, k)) ||
            !Number.isInteger(gameState.reviewPlan.remaining) || gameState.reviewPlan.remaining < 0 || gameState.reviewPlan.remaining > 2 ||
            !Number.isInteger(gameState.reviewPlan.expiresWeek))) gameState.reviewPlan = null;
        gameState.currentGoal = stageGoals[gameState.goalWeek] || null;
        clampState();
        return true;
    } catch (_) { return false; }
}
function restartGame() {
    if (!confirm('重新开始会清除本设备上的这一局进度。确定重新开始吗？')) return;
    try { localStorage.removeItem(saveKey); } catch (_) { /* Storage can be unavailable on file URLs. */ }
    location.reload();
}
const legacyLog = addToLog;
addToLog = function(text, type = 'neutral') {
    const time = `W${gameState.week} ${['一', '二', '三', '四', '五', '六', '日'][gameState.dayOfWeek]}`;
    gameState.logHistory.unshift({ text, type, time });
    gameState.logHistory = gameState.logHistory.slice(0, 100);
    legacyLog(text, type, time);
};
updateUI = function() {
    legacy.updateUI();
    const total = document.getElementById('achievement-total');
    if (total) total.textContent = Object.keys(achievements).length;
    const info = document.getElementById('narrative-status');
    if (info) info.textContent = `主线 ${gameState.storyProgress}/36 · 当前学习效率 ${calculateStudyEfficiency().toFixed(2)} · ${saveAvailable ? '进度自动保存在本设备' : '本设备无法保存，关闭页面前请留意'}`;
    const resume = document.getElementById('narrative-btn');
    if (resume) resume.textContent = gameState.activeNarrative || gameState.narrativeFeedback ? '继续未完成的剧情' : '本周剧情与支线';
    const plan = document.getElementById('review-plan-status');
    if (plan) plan.textContent = activeReviewPlan() ? `复盘提示：${gameState.reviewPlan.subjects.map(k => subjectNames[k]).join('、')}，还可用于${gameState.reviewPlan.remaining}次主动学习，至第${gameState.reviewPlan.expiresWeek}周结束。` : '模考后三周内可复盘一次，结合后续学习巩固薄弱科目。';
};
function checkActionLimit() {
    if (gameState.gameOver || gameState.phase !== 'playing') return false;
    if (gameState.activeNarrative || gameState.narrativeFeedback || gameState.weekEnding) {
        showNotification('请先继续未完成的剧情。', 'neutral');
        return false;
    }
    if (gameState.actionsThisWeek >= 3) {
        showNotification('本周三次行动已用完，请结束本周。', 'neutral');
        return false;
    }
    return true;
};
function recordAction() {
    gameState.actionsThisWeek++;
    if (actionInProgress) {
        gameState.actionHistory.push({ week: gameState.week, kind: actionInProgress.kind, detail: actionInProgress.detail });
    }
    clampState();
    updateActionCounter();
};
function performAction(kind, detail, action) {
    if (!checkActionLimit()) return;
    const count = gameState.actionsThisWeek;
    const beforeHomework = { ...gameState.homework };
    const beforeMoney = gameState.money;
    actionInProgress = { kind, detail };
    try { action(); } finally { actionInProgress = null; }
    if (gameState.actionsThisWeek === count) return;
    if (kind === 'homework') {
        const completed = Object.keys(subjectNames).filter(k => !beforeHomework[k] && gameState.homework[k]);
        const last = gameState.actionHistory.at(-1);
        if (last) last.subjects = completed;
        gameState.totalHomework += completed.length;
    }
    if (gameState.money > beforeMoney) gameState.totalIncome += gameState.money - beforeMoney;
    if (kind === 'rest' && detail === 'counseling') gameState.actionHistory.at(-1).support = true;
    clampState();
    updateUI();
    saveGame();
    if (gameState.deferredRandom && !dueMainStories().length) triggerRandomEvent();
}
study = function(subject) {
    const costs = { chinese: 25, math: 35, english: 25, physics: 35, chemistry: 20, biology: 20 };
    if (!Object.hasOwn(costs, subject)) return;
    if (gameState.energy < costs[subject]) { showNotification(`学习${subjectNames[subject]}需要${costs[subject]}精力。`, 'neutral'); return; }
    performAction('study', subject, () => {
        const before = gameState.subjects[subject];
        const count = gameState.actionsThisWeek;
        const assisted = activeReviewPlan() && gameState.reviewPlan.subjects.includes(subject);
        legacy.study(subject);
        if (assisted && gameState.actionsThisWeek > count) {
            const gain = gameState.subjects[subject] - before;
            const bonus = Math.min(100 - gameState.subjects[subject], gain * 0.20);
            applyEffect({ [subject]: bonus });
            gameState.reviewPlan.remaining--;
            addToLog(`沿着模考复盘提示学习${subjectNames[subject]}，额外巩固 +${bonus.toFixed(1)}。`, 'good');
        }
    });
};
rest = function(type) {
    if (!['sleep', 'nap', 'relax', 'music', 'counseling'].includes(type)) return;
    performAction('rest', type, () => legacy.rest(type));
};
exercise = function() { performAction('exercise', null, legacy.exercise); };
homework = function(action) {
    if (!['complete-all', 'complete-one', 'skip'].includes(action)) return;
    performAction('homework', action, () => legacy.homework(action));
};
activity = function(type) {
    const costs = { club: 15, volunteer: 25, lecture: 10, competition: 35, 'oi-meetup': 20 };
    if (!Object.hasOwn(costs, type)) return;
    if (gameState.energy < costs[type]) { showNotification(`这项活动需要${costs[type]}精力。`, 'neutral'); return; }
    performAction('activity', type, () => legacy.activity(type));
};
economy = function(action) {
    if (!['part-time', 'buy-books', 'buy-course', 'parents'].includes(action)) return;
    performAction('economy', action, () => legacy.economy(action));
};
function advanceTime() {
    // Three actions are slices of the current week; the week alone owns the countdown.
    gameState.period = (gameState.period + 1) % 4;
    gameState.dayOfWeek = Math.min(6, gameState.actionsThisWeek * 2);
};
takeExam = function() {
    if (!checkActionLimit()) return;
    const count = gameState.examCount;
    performAction('exam', null, legacy.takeExam);
    if (gameState.examCount !== count) saveGame();
};
function showMenu(title, text, entries) {
    elements.storyTitle.textContent = title;
    elements.storyContent.innerHTML = paragraphs(text);
    elements.storyChoices.innerHTML = '';
    for (const entry of entries) {
        const button = document.createElement('button');
        button.className = 'story-choice-btn';
        button.textContent = entry.text;
        button.onclick = entry.action;
        elements.storyChoices.appendChild(button);
    }
    document.getElementById('story-modal').style.display = 'flex';
}
function social(target) {
    if (!target) {
        if (!checkActionLimit()) return;
        showMenu('这次想和谁交流？', '消耗一次行动、15精力；健康至少50。关系改善只属于本次选择的对象。',
            Object.entries(relationshipNames).map(([key, name]) => ({ text: name, action: () => social(key) })));
        return;
    }
    if (!Object.hasOwn(relationshipNames, target) || !checkActionLimit()) return;
    if (gameState.energy < 15 || gameState.health < 50) { showNotification('社交需要15精力，健康至少50。', 'neutral'); return; }
    performAction('social', target, () => {
        const bonus = [5, 8, 3, 4][Math.floor(Math.random() * 4)];
        const stress = [-5, -3, 5, -8][Math.floor(Math.random() * 4)];
        applyEffect({ energy: -15, stress: -10 + stress, anxiety: -5, [target]: 5 + bonus });
        gameState.totalSocialHours++;
        addToLog(`与${relationshipNames[target]}聊了这次愿意分享的事情，关系 +${5 + bonus}。`, 'good');
        closeModal('story-modal');
        recordAction(); advanceTime();
    });
};
function activeReviewPlan() {
    return gameState.reviewPlan && gameState.reviewPlan.remaining > 0 && gameState.week <= gameState.reviewPlan.expiresWeek;
}
function availableReviews() {
    if (gameState.phase !== 'playing') return [];
    return gameState.examHistory.map((exam, index) => ({ exam, index })).filter(({ exam, index }) =>
        !gameState.reviewedExams.includes(index) && gameState.week >= exam.week && gameState.week <= exam.week + 3 &&
        Object.keys(subjectNames).every(k => Number.isFinite(exam.subjects?.[k])));
}
function reviewExam(index) {
    if (!checkActionLimit()) return;
    const reviews = availableReviews();
    if (index === undefined) {
        showMenu('模考复盘', '每场模考后三周内一次，消耗一次行动、20精力。根据当场实际表现选择两科，各 +3，压力 -5、焦虑 -6。接下来三周内，两次相关科目的主动学习增益 +20%；提示不叠加。',
            reviews.map(({ exam, index: i }) => ({ text: `第${exam.week}周模考：${exam.score}/100`, action: () => reviewExam(i) })).concat(
                [{ text: '返回本周安排', action: () => closeModal('story-modal') }]));
        return;
    }
    const match = reviews.find(r => r.index === index);
    if (!match) { showNotification('这场模考已复盘或已超过三周窗口。', 'neutral'); return; }
    if (gameState.energy < 20) { showNotification('复盘需要20精力。', 'neutral'); return; }
    const subjects = Object.keys(subjectNames).sort((a, b) => match.exam.subjects[a] - match.exam.subjects[b]).slice(0, 2);
    performAction('review', String(index), () => {
        applyEffect({ energy: -20, stress: -5, anxiety: -6, ...Object.fromEntries(subjects.map(k => [k, 3])) });
        gameState.reviewedExams.push(index);
        gameState.reviewPlan = { subjects, remaining: 2, expiresWeek: Math.min(52, gameState.week + 3) };
        gameState.totalReviews++;
        addToLog(`复盘第${match.exam.week}周的真实模考记录：核对${subjects.map(k => subjectNames[k]).join('、')}；低分不直接等于逐题答错，今天从基础材料复做。`, 'good');
        closeModal('story-modal'); recordAction();
        gameState.actionHistory.at(-1).subjects = subjects;
        advanceTime();
    });
}
function groupSubjects(target) {
    if (['classmateA', 'classmateB', 'crush'].includes(target)) return Object.keys(subjectNames);
    const teaching = { teacher: 'physics', mathTeacher: 'math', chineseTeacher: 'chinese', englishTeacher: 'english' };
    return teaching[target] ? [teaching[target]] : [];
}
function availableStudyPartners() {
    return Object.keys(relationshipNames).filter(k => groupSubjects(k).length && gameState.relationships[k] >= 60);
}
function studyTogether(target, subject) {
    if (!checkActionLimit()) return;
    if (gameState.studyGroupWeek === gameState.week) { showNotification('本周已经共同学习过一次，把其他时间留给各自的安排。', 'neutral'); return; }
    if (!target) {
        showMenu('一起核对一处课内问题', '每周一次，消耗一次行动、20精力，需要健康至少50、对应关系至少60。按当前学习效率和能力增长，压力 -4、焦虑 -4，关系 +2；不保证对方已经知道全部答案。',
            availableStudyPartners().map(k => ({ text: relationshipNames[k], action: () => studyTogether(k) })).concat(
                [{ text: '返回本周安排', action: () => closeModal('story-modal') }]));
        return;
    }
    if (!availableStudyPartners().includes(target)) return;
    if (!subject) {
        showMenu(`与${relationshipNames[target]}核对哪门课？`, '同学可一起查教材；任课老师只处理对应学科。共同学习不能代替全部独立练习。',
            groupSubjects(target).map(k => ({ text: subjectNames[k], action: () => studyTogether(target, k) })).concat(
                [{ text: '返回伙伴选择', action: () => studyTogether() }]));
        return;
    }
    if (!groupSubjects(target).includes(subject) || gameState.energy < 20 || gameState.health < 50) { showNotification('共同学习需要20精力、健康至少50及对应的学科条件。', 'neutral'); return; }
    performAction('studyGroup', subject, () => {
        const gain = studyBalance.groupBase * calculateStudyEfficiency() * (1 - gameState.subjects[subject] / 200);
        applyEffect({ energy: -20, stress: -4, anxiety: -4, [target]: 2, [subject]: gain });
        gameState.studyGroupWeek = gameState.week;
        gameState.totalStudyGroups++;
        addToLog(`与${relationshipNames[target]}一起核对${subjectNames[subject]}教材，能力 +${gain.toFixed(1)}；今天各自仍有要继续做的部分。`, 'good');
        closeModal('story-modal'); recordAction(); advanceTime();
    });
}
function memory() {
    if (!checkActionLimit()) return;
    const available = narrativeData.stories.filter(n => n.kind === 'memory' && !gameState.events.includes(n.id));
    showMenu('主动回忆', '每个片段每局一次，确认片段中的选择后消耗一次行动、10精力，焦虑 -2。',
        available.length ? available.map(node => ({ text: node.title, action: () => triggerStoryEvent(node) })) :
            [{ text: '四个片段都已读完，返回今天的安排', action: () => closeModal('story-modal') }]);
};
function actionsMatching(values, state = gameState, weeks = 1) {
    return state.actionHistory.filter(a => a.week <= state.week && a.week >= state.week - weeks + 1 && values.some(value => {
        const [kind, detail] = value.split(':');
        return a.kind === kind && (!detail || a.detail === detail || a.subjects?.includes(detail));
    }));
}
function matchesRule(rule, state = gameState) {
    switch (rule.type) {
        case 'all': return rule.rules.every(r => matchesRule(r, state));
        case 'any': return rule.rules.some(r => matchesRule(r, state));
        case 'week': return state.week >= rule.min && state.week <= rule.max;
        case 'value': {
            const value = Object.hasOwn(subjectNames, rule.field) ? state.subjects[rule.field] : Object.hasOwn(relationshipNames, rule.field) ? state.relationships[rule.field] : state[rule.field];
            if (!Number.isFinite(value)) return false;
            return rule.op === 'range' ? value >= rule.value && value <= rule.max : rule.op === '≥' ? value >= rule.value : rule.op === '≤' ? value <= rule.value : rule.op === '>' ? value > rule.value : value < rule.value;
        }
        case 'weather': return rule.values.some(v => v === state.currentWeather.id || v === 'afterRain' && ['rain', 'thunder'].includes(state.previousWeather) && !['rain', 'thunder'].includes(state.currentWeather.id));
        case 'action': return actionsMatching(rule.values, state, rule.weeks).length >= rule.min;
        case 'noAction': return actionsMatching(rule.values, state).length === 0;
        case 'studyCount': return state.totalStudyHours >= rule.min;
        case 'subjectThreshold': return Object.values(state.subjects).some(v => rule.op === '≥' ? v >= rule.value : rule.op === '≤' ? v <= rule.value : rule.op === '>' ? v > rule.value : v < rule.value);
        case 'exam': return state.examHistory.length > 0;
        case 'reviewLatestExam': return state.actionHistory.some(a => a.week === state.week && a.kind === 'review' && a.detail === String(state.examHistory.length - 1));
        case 'oldDraft': return state.storyChoices.S30?.key !== 'C';
        case 'oldProgram': return state.oldProgramAccess;
        case 'unfinishedHomework': return Object.values(state.homework).some(done => !done);
        case 'transaction': return actionsMatching(['economy:part-time', 'economy:buy-books', 'economy:buy-course', 'economy:parents', 'rest:counseling'], state).length > 0;
        default: throw new Error(`未知事件条件：${rule.type}`);
    }
}
function isNegativeEffect(effect) {
    return Object.entries(effect).some(([key, val]) => key === 'subjects' ? Object.values(val).some(v => v < 0) : ['stress', 'anxiety'].includes(key) ? val > 0 : val < 0);
}
function protectedFrom(effect, state = gameState) {
    return state.stress >= 80 && (effect.stress || 0) > 0 || state.anxiety >= 80 && (effect.anxiety || 0) > 0 ||
        state.health <= 30 && (effect.health || 0) < 0 || state.mental <= 30 && (effect.mental || 0) < 0;
}
function availableRandomEvents(state = gameState) {
    if (state.finalSnapshot || state.randomCountThisWeek >= 1) return [];
    return narrativeData.random.filter(event => !event.disabledReason && !state.randomSeen.includes(event.id) &&
        event.rules.every(rule => matchesRule(rule, state)) && event.choices.every(c => !protectedFrom(c.effect, state)) &&
        (!event.choices.some(c => isNegativeEffect(c.effect)) || state.week - (state.lastNegativeWeek[event.category] ?? -100) > 3));
}
function triggerRandomEvent() {
    if (gameState.finalSnapshot || gameState.randomCountThisWeek >= 1 || gameState.weekRandomAttempted) return;
    if (actionInProgress || gameState.activeNarrative || gameState.narrativeFeedback || dueMainStories().length) {
        gameState.deferredRandom = true;
        return;
    }
    drawRandomEvent();
};
function drawRandomEvent() {
    gameState.weekRandomAttempted = true;
    gameState.deferredRandom = false;
    const available = availableRandomEvents();
    if (!available.length) return;
    const event = available[Math.floor(Math.random() * available.length)];
    gameState.narrativeQueue.push(event.id);
    pumpNarrative();
}
function findNarrative(id) {
    return narrativeData.stories.find(n => n.id === id) || narrativeData.random.find(n => n.id === id);
}
function dueMainStories() {
    return narrativeData.stories.filter(n => n.kind === 'main' && n.id !== 'S36' && n.week <= gameState.week && !gameState.events.includes(n.id));
}
function availableSideStories() {
    const entry = { H01: 'S13', H02: 'S21', H03: 'S23', H04: 'S14', H05: 'S24' };
    return narrativeData.stories.filter(n => n.kind === 'side' && n.week <= gameState.week && gameState.week <= n.until && !gameState.events.includes(n.id) &&
        (n.id === 'H06' ? Object.values(gameState.subjects).some(v => v < 40) : gameState.events.includes(entry[n.id])));
}
function resumeNarrative() {
    if (gameState.phase !== 'playing') { renderPostExam(); pumpNarrative(); return; }
    if (gameState.narrativeFeedback || gameState.activeNarrative || gameState.narrativeQueue.length) { pumpNarrative(); return; }
    const due = dueMainStories();
    const sides = availableSideStories();
    showMenu('本周剧情与支线', '主线和可选支线不消耗常规行动。关闭窗口后可从这里继续；支线是否参与由你决定。',
        [...due, ...sides].map(n => ({ text: `${n.kind === 'main' ? '主线' : '支线'}：${n.title}`, action: () => triggerStoryEvent(n) })).concat(
            [{ text: '回到本周安排', action: () => closeModal('story-modal') }]));
}
function triggerStoryEvent(node) {
    if (gameState.events.includes(node.id)) return;
    if (node.kind === 'memory' && (gameState.energy < 10 || gameState.actionsThisWeek >= 3)) { showNotification('回忆需要10精力和一次行动。', 'neutral'); return; }
    if (!gameState.narrativeQueue.includes(node.id) && gameState.activeNarrative !== node.id) gameState.narrativeQueue.push(node.id);
    pumpNarrative();
};
function checkHiddenEvents() { /* Optional scenes are entered explicitly through the narrative menu. */ };
function resolveChoices(node, state = gameState) {
    const all = Object.keys(subjectNames);
    const resolved = [];
    for (const c of node.choices) {
        if (!c.target) { resolved.push({ ...c, targets: [] }); continue; }
        let allowed = all;
        if (c.target === 'weak' || c.target === 'strong') {
            const limit = Math[c.target === 'weak' ? 'min' : 'max'](...Object.values(state.subjects));
            allowed = all.filter(k => state.subjects[k] === limit);
        }
        if (c.target.includes('Below40')) allowed = all.filter(k => state.subjects[k] < 40);
        if (c.target === 'discussion') allowed = all.filter(k => state.subjects[k] >= 35);
        if (c.target === 'examMistake') allowed = (state.examHistory.at(-1)?.mistakeSubjects || []).filter(k => Object.hasOwn(subjectNames, k));
        if (c.target === 'lastStudy') {
            const last = state.actionHistory.filter(a => a.week === state.week && a.kind === 'study').at(-1);
            allowed = last && Object.hasOwn(subjectNames, last.detail) ? [last.detail] : [];
        }
        const targets = [];
        if (c.target !== 'pair') for (const k of allowed) targets.push([k]);
        if (c.target === 'pair' || c.target === 'oneOrPairBelow40') {
            for (let i = 0; i < allowed.length; i++) for (let j = i + 1; j < allowed.length; j++) targets.push([allowed[i], allowed[j]]);
        }
        for (const group of targets) {
            const effect = { ...c.effect };
            for (const k of group) effect[k] = c.targetGain ?? (group.length === 1 ? 1.2 : 0.6);
            resolved.push({ ...c, targets: group, effect });
        }
    }
    return resolved;
}
function examTrend(state = gameState) {
    const h = state.examHistory;
    if (!h.length) return '这页还没有模考记录。今天从实际做过的练习开始，不用一场不存在的考试替你宣布进步。';
    if (h.length === 1) return `蓝本里只有一条模考记录：第${h[0].week}周，${h[0].score}/100。一条数字暂时只是起点。`;
    const a = h.at(-2), b = h.at(-1);
    return `两次真实模考记录：第${a.week}周 ${a.score}/100，第${b.week}周 ${b.score}/100。${b.score > a.score ? '这次向上挪了一些，可以先为这一小段高兴。' : '这次持平或下降，还需要分清已经掌握的部分和仍要处理的问题。'}`;
}
function renderStoryContent(node) {
    let text = node.content;
    const choice = id => gameState.storyChoices[id]?.key;
    const source = { A: '作业单', B: '页码小框', C: '夹在最前面的课表' }[choice('S01')] || '课表';
    if (node.id === 'S07') text = text.split('按实际记录显示一段：')[0] + '\n\n' + examTrend();
    if (node.id === 'S12') text = text.replace(/若 S03[\s\S]*?当时的气话。/, ({ A: '对方问起约好的简短汇报，你指着纸上仍待核实的问号。', B: '对方问是不是到了约定谈话的时间。', C: '对方问起准备交给班主任的提问草稿，仍需核实的事留在纸上。' }[choice('S03')] || '对方只问：“现在方便聊吗？”'));
    if (node.id === 'S22') {
        text = text.split('先读目标的真实记录')[0];
        const goal = gameState.practiceGoal;
        const attempts = goal ? gameState.actionHistory.filter(a => a.week >= goal.week && a.week < gameState.week && a.kind === 'study' && goal.subjects.includes(a.detail)).length : 0;
        text += '\n\n' + (attempts ? `你在实际记录里找到${attempts}次对应科目的学习尝试。它能说明投入发生过，是否独立掌握仍需在练习里核实。` : '这一栏还没有可核对的后续学习记录。今天可以先问材料是否齐全，再把问题缩小一点。') + '\n\n' + examTrend();
    }
    if (node.id === 'S23') text = text.replace(/如果 S09 未发生[\s\S]*?。/, choice('S09') ? '' : '他补了一句：“现在的声音比刚修时有底气一点。”');
    if (node.id === 'S25') text = text.replace(/你们翻回 S05 的材料。[\s\S]*?用今天这份练笔。/, `你们翻回${choice('S05') === 'A' ? '食堂托盘与汤渍的观察' : choice('S05') === 'C' ? '叶片朝向的观察' : '今天这份练笔'}，从真实留下的句子继续看。`);
    if (node.id === 'S27') text = text.split('状态插句：')[0] + '\n\n' + (gameState.health < 45 || gameState.energy < 25 ? '把东西放下后，你才发现自己一直揉着眼睛。必要的休息要在今天的安排里留位置。' : '你看到同桌手背上的胶带印，也发现自己的计划需要留白。') + (gameState.anxiety >= 65 || gameState.stress >= 75 ? '\n\n你盯着被划掉的事情，总觉得还漏了什么。' : '');
    if (node.id === 'S29') text = text.split('按实际材料呈现：')[0] + '\n\n' + examTrend();
    if (node.id === 'S34') text = text.split('S03、S21')[0] + '\n\n' + (gameState.relationships.parents < 50 ? '你们说话仍容易绕回旧争论，于是先只谈一项。' : '你们已经知道哪些话题需要先问是否方便。') + '哪些费用能够承担，仍要逐项核实。';
    if (node.id === 'S35') text = text.split('读取真实状态：')[0] + '\n\n' + (gameState.health < 45 ? '必要的身体照护先放在前面，其他事情可以分开处理。' : gameState.anxiety >= 65 || gameState.stress >= 75 ? '手机每一次亮屏都让你想伸手。今晚只先处理能确认的一小段。' : '你有余力整理桌面，把必要的东西留在手边。') + `\n\n蓝本里仍留着第一天的${source}。`;
    if (node.id === 'M04') text = text.split('你和他们现在')[0] + '\n\n你可以问候，也可以今天先看完。没有联系记录时，不替任何人宣布关系破裂。';
    const refs = { S03: '之前家里谈话', S07: '之前留下的学习页', S08: '通知栏试做', S10: '那次互助', S12: '之前饭桌谈话', S16: '小群约定', S18: '之前的小目标', S19: '限时练习', S22: '练习核对', S24: '之前在校门口的', S25: '修改过的练笔', S26: '课堂尝试', S29: '复做页' };
    text = text.replace(/S\d{2}/g, id => refs[id] || '之前的那次选择');
    if (['S02', 'S06', 'S09', 'S13', 'S16', 'S18', 'S19', 'S21', 'S23', 'S26', 'S31', 'S32', 'S33', 'S36'].includes(node.id)) {
        const callbacks = {
            S02: `蓝本旁还放着第一天留下的${source}。`,
            S06: { A: '你翻回上次留下的一题样本。', B: '那张互圈纸还夹在课表边。', C: '你拿出了写着对象、条件、单位、结论的检查卡。' }[choice('S02')],
            S09: '这次可以聊修车、做饭和各自的安排，朋友的生活不只有功课。',
            S13: '你知道可以主动联系原教练，也可以今天先停在这里。',
            S18: examTrend(),
            S31: '蓝本里可以找到之前留下的范围和安排；没有核实的项目仍留白。',
            S36: `收拾时，你又看见第一天的${source}。`
        };
        if (callbacks[node.id]) text += '\n\n' + callbacks[node.id];
    }
    return text.trim();
}
function choiceFeedback(node, c) {
    if (node.id === 'S33' && c.key === 'A') return gameState.storyChoices.S24?.key === 'A' ?
        '她说：“这段时间过下来，我知道我喜欢你。我想听听你的回答。”你明确回应同样的喜欢。你们确认各自的计划仍需各自安排，感情共识为明确互相喜欢。' :
        '你提出从现在慢慢了解，她表示愿意。你们确认联系范围，感情共识为慢慢了解，不要求同校或同城。';
    if (node.id === 'S36') return { A: '成绩已经留在蓝本里。你先了解升学方向，也可以返回比较其他安排。', B: '升学、复读、休整、工作与继续学习同时开放，确认前可以自由返回。', C: '今天先吃一顿不必卡着下课铃的饭。去向仍未确认，回来后可继续查看全部方向。' }[c.key];
    return c.feedback.replace(/S\d{2}/g, '之前的那次选择');
}
function showNarrative(node) {
    const entries = node.choices.map(c => ({
        text: `${c.text}\n${previewEffect(c.effect)}${c.target ? c.target === 'lastStudy' ? `；本周最近一次主动学习科目 +${c.targetGain}` : `；另选科目，总能力 +${c.targetGain ?? 1.2}` : ''}`,
        action: () => {
            if (c.target) {
                const resolved = resolveChoices(node).filter(x => x.key === c.key);
                showMenu('选择这次处理的科目', '并列的最弱或最强科目可以自行选择；两门科目须不同。',
                    resolved.map(x => ({ text: `${x.targets.map(k => subjectNames[k]).join('、')}：${previewEffect(x.effect)}`, action: () => commitNarrativeChoice(node, x) })).concat(
                        [{ text: '返回本段选项', action: () => showNarrative(node) }]));
            } else commitNarrativeChoice(node, { ...c, targets: [] });
        }
    }));
    if (node.kind === 'memory') entries.push({ text: '今天先不回忆（不扣行动和精力）', action: () => { gameState.activeNarrative = null; closeModal('story-modal'); saveGame(); pumpNarrative(); } });
    showMenu(`${node.kind === 'memory' ? '回忆：' : node.kind === 'side' ? '支线：' : ''}${node.title}`, renderStoryContent(node), entries);
    if (node.commonEffect || node.cost) {
        elements.storyContent.innerHTML += `<p class="narrative-note">${node.commonEffect ? '本学段课堂练习与整理：六科各 +0.2；' : ''}${node.cost ? '确认后：一次行动，精力 -10，焦虑 -2；' : '本段不消耗常规行动；'}选择效果见下方。</p>`;
    }
    // Disable costs before clicking as well as validating them again at settlement.
    Array.from(elements.storyChoices.children).forEach((button, i) => {
        const c = node.choices[i];
        if (c && (c.effect.money || 0) < -gameState.money) { button.disabled = true; button.textContent += '（余额不足）'; }
    });
}
function commitNarrativeChoice(node, c) {
    if (gameState.activeNarrative !== node.id || gameState.events.includes(node.id) || gameState.randomSeen.includes(node.id)) return false;
    if (gameState.finalSnapshot && node.id !== 'S36') return false;
    if ((c.effect.money || 0) < -gameState.money) return false;
    if (node.kind === 'memory' && (gameState.actionsThisWeek >= 3 || gameState.energy < 10)) return false;
    if (node.commonEffect) applyEffect(node.commonEffect);
    if (node.cost) applyEffect(node.cost);
    applyEffect(c.effect);
    const record = { key: c.key, targets: c.targets || [], week: gameState.week };
    if (node.kind === 'random') {
        gameState.randomSeen.push(node.id);
        gameState.randomCountThisWeek++;
        if (isNegativeEffect(c.effect)) gameState.lastNegativeWeek[node.category] = gameState.week;
        if (isNegativeEffect(c.effect)) gameState.negativeRandomThisWeek = true;
        elements.randomEvent.textContent = node.content;
    } else {
        gameState.events.push(node.id);
        if (node.kind === 'main') {
            gameState.storyChoices[node.id] = record; gameState.storyProgress++;
            if (gameState.storyProgress === 36) unlockAchievement('story-36');
        }
        if (node.kind === 'memory') {
            gameState.memoryChoices[node.id] = record;
            gameState.memoryCount++;
            gameState.actionsThisWeek++;
            gameState.actionHistory.push({ week: gameState.week, kind: 'memory', detail: node.id });
            if (node.id === 'M01' && c.key === 'A') gameState.oldProgramAccess = true;
            advanceTime();
        }
        if (node.kind === 'side') gameState.actionHistory.push({ week: gameState.week, kind: 'side', detail: node.id });
    }
    if (node.id === 'S24') gameState.romance = { A: '慢慢了解', B: '朋友', C: '暂不命名' }[c.key];
    if (node.id === 'S33') {
        gameState.mutualAffirmation = c.key === 'A' && gameState.storyChoices.S24?.key === 'A';
        gameState.romance = c.key === 'A' ? gameState.mutualAffirmation ? '明确互相喜欢' : '慢慢了解' : c.key === 'B' ? '朋友' : '暂不命名';
    }
    if (node.id === 'S18') gameState.practiceGoal = { week: gameState.week, subjects: c.targets?.length ? c.targets : Object.keys(subjectNames) };
    gameState.activeNarrative = null;
    gameState.narrativeFeedback = { title: node.title, text: choiceFeedback(node, c), postChoice: node.id === 'S36' ? c.key : null };
    addToLog(`${node.title}：${c.text}${c.targets?.length ? '（' + c.targets.map(k => subjectNames[k]).join('、') + '）' : ''}`, 'story');
    if (gameState.phase === 'playing') { checkAchievements(); updateUI(); }
    saveGame();
    pumpNarrative();
    return true;
}
function continueNarrative() {
    const feedback = gameState.narrativeFeedback;
    if (!feedback) return;
    gameState.narrativeFeedback = null;
    closeModal('story-modal');
    saveGame();
    if (feedback.postChoice) { renderPostExam(feedback.postChoice === 'A' ? 'C01' : null); return; }
    pumpNarrative();
}
function pumpNarrative() {
    if (gameState.narrativeFeedback) {
        showMenu(gameState.narrativeFeedback.title, gameState.narrativeFeedback.text || '这一小段已记录。', [{ text: '继续', action: continueNarrative }]);
        return;
    }
    if (!gameState.activeNarrative && gameState.narrativeQueue.length) gameState.activeNarrative = gameState.narrativeQueue.shift();
    if (gameState.activeNarrative) {
        const node = findNarrative(gameState.activeNarrative);
        if (!node) throw new Error('无法恢复剧情：' + gameState.activeNarrative);
        showNarrative(node);
        saveGame();
        return;
    }
    if (gameState.weekEnding) continueWeekEnd();
    else if (gameState.phase === 'playing' && gameState.deferredRandom && !dueMainStories().length) triggerRandomEvent();
}
function endWeek() {
    if (gameState.phase !== 'playing') return;
    if (gameState.weekEnding || gameState.activeNarrative || gameState.narrativeFeedback) { pumpNarrative(); return; }
    if (gameState.actionsThisWeek < 3 && !confirm(`本周还有${3 - gameState.actionsThisWeek}次行动机会，确定结束本周吗？`)) return;
    closeModal('story-modal');
    gameState.weekEnding = true;
    continueWeekEnd();
};
function continueWeekEnd() {
    if (gameState.activeNarrative || gameState.narrativeFeedback || gameState.narrativeQueue.length) { pumpNarrative(); return; }
    // All final-week random effects settle before S35 freezes the score.
    if (gameState.week === 52 && !gameState.weekRandomAttempted) {
        const shouldDraw = gameState.deferredRandom || Math.random() < 0.6;
        gameState.weekRandomAttempted = true;
        if (shouldDraw) { gameState.weekRandomAttempted = false; drawRandomEvent(); if (gameState.activeNarrative) return; }
    }
    const due = dueMainStories();
    if (due.length) { gameState.narrativeQueue.push(...due.map(n => n.id)); pumpNarrative(); return; }
    if (!gameState.weekRandomAttempted) {
        const shouldDraw = gameState.deferredRandom || Math.random() < 0.6;
        gameState.weekRandomAttempted = true;
        if (shouldDraw) { gameState.weekRandomAttempted = false; drawRandomEvent(); if (gameState.activeNarrative) return; }
    }
    applyEffect({ energy: 8, stress: -5 + Math.floor(gameState.anxiety * 0.2), health: 2, mental: 2 - Math.floor(gameState.anxiety * 0.1), anxiety: 2 });
    gameState.completedWeeks++;
    gameState.lowStressWeeks = gameState.stress < 10 ? gameState.lowStressWeeks + 1 : 0;
    gameState.highEnergyWeeks = gameState.energy > 90 ? gameState.highEnergyWeeks + 1 : 0;
    if (!gameState.negativeRandomThisWeek && gameState.stress <= 50 && gameState.anxiety <= 60 && gameState.actionsThisWeek > 0) gameState.perfectWeeks++;
    settleStageGoal();
    gameState.vacationDays = Math.max(0, gameState.vacationDays - 7);
    gameState.daysLeft = (52 - gameState.completedWeeks) * 7;
    gameState.weekEnding = false;
    checkAchievements();
    if (gameState.week === 52) { endGame(); return; }
    gameState.week++;
    gameState.actionsThisWeek = 0;
    gameState.dayOfWeek = 0; gameState.period = 0;
    gameState.weekActivities = 0;
    for (const k in gameState.homework) gameState.homework[k] = false;
    gameState.randomCountThisWeek = 0; gameState.weekRandomAttempted = false; gameState.deferredRandom = false;
    gameState.negativeRandomThisWeek = false;
    gameState.season = Math.min(3, Math.floor((gameState.week - 1) / 13));
    checkHolidays(); checkStageGoals(); generateSchedule(); changeWeather();
    addToLog(`第${gameState.week}周开始，距离考试还有${gameState.daysLeft}个抽象学年日。`, 'neutral');
    updateUI(); saveGame();
}
function checkStageGoals() {
    const next = Object.keys(stageGoals).map(Number).find(w => w >= gameState.week && !Object.hasOwn(gameState.goalResults, w));
    gameState.goalWeek = next || null;
    gameState.currentGoal = next ? stageGoals[next] : null;
    gameState.goalProgress = 0;
};
function settleStageGoal() {
    if (gameState.goalWeek !== gameState.week || Object.hasOwn(gameState.goalResults, gameState.week)) return;
    const goal = stageGoals[gameState.week];
    const achieved = goal.check(gameState);
    gameState.goalResults[gameState.week] = achieved;
    if (achieved) applyEffect(goal.reward);
    addToLog(`${goal.title}：${achieved ? '达成，已获得奖励' : '尚未达成，后面的安排仍可继续'}。`, achieved ? 'good' : 'neutral');
}
function updateGoalText() {
    const goal = gameState.currentGoal;
    elements.currentGoal.textContent = goal ? `${goal.desc}；截止第${gameState.goalWeek}周结束` : '本轮阶段目标已结算';
    elements.goalProgress.style.width = goal?.check(gameState) ? '100%' : '0%';
};
changeWeather = function() {
    gameState.previousWeather = gameState.currentWeather?.id || null;
    legacy.changeWeather();
    const ids = { '晴天': 'sun', '阴天': 'cloud', '雨天': 'rain', '雷雨': 'thunder', '雾霾': 'fog' };
    gameState.currentWeather = { ...gameState.currentWeather, id: ids[gameState.currentWeather.name] };
};
function checkSpecialDay() { /* The calendar is an abstract 52-week year. */ };
function unlockAchievement(id) {
    if (!Object.hasOwn(achievements, id) || gameState.achievements.has(id)) return;
    gameState.achievements.add(id);
    showNotification(`成就：${achievements[id].name}`, 'good');
};
checkAchievements = function() {
    legacy.checkAchievements();
    // These checks use completed/cumulative records, never a current-week boolean count.
    if (gameState.completedWeeks >= 1) unlockAchievement('first-week');
    if (gameState.completedWeeks >= 4) unlockAchievement('first-month');
    if (gameState.totalHomework >= 100) unlockAchievement('homework-100');
    if (gameState.memoryCount >= 4) unlockAchievement('memory-4');
    if (gameState.lowStressWeeks >= 10) unlockAchievement('stress-management');
    if (gameState.highEnergyWeeks >= 5) unlockAchievement('early-bird');
    if (gameState.totalIncome >= 1000) unlockAchievement('money-maker');
    if (gameState.storyProgress >= 36) unlockAchievement('story-36');
    if (gameState.storyProgress >= 10) unlockAchievement('story-10');
    if (gameState.perfectWeeks >= 2) unlockAchievement('perfect-week');
    const sides = gameState.events.filter(id => /^H/.test(id)).length;
    for (let i = 1; i <= 3; i++) if (sides >= i) unlockAchievement('hidden-' + i);
};
function chooseEpilogues(state = gameState) {
    const index = id => ({ A: '01', B: '02', C: '03' }[state.storyChoices[id]?.key] || '04');
    const final = state.finalSnapshot;
    let health = 'ST04';
    if (final && ['health', 'mental', 'anxiety', 'stress'].every(k => Number.isFinite(final[k]))) {
        health = final.health < 45 ? 'ST01' : final.anxiety >= 65 || final.stress >= 75 || final.mental < 45 ? 'ST02' :
            final.health >= 75 && final.mental >= 65 && final.anxiety < 40 && final.stress < 50 ? 'ST03' : 'ST04';
    }
    const peer = state.romance === '朋友' ? 'PEER01' : state.romance === '慢慢了解' ? 'PEER02' : state.romance === '明确互相喜欢' && state.mutualAffirmation ? 'PEER03' : 'PEER04';
    return ['F' + index('S34'), 'DESK' + index('S28'), 'TEAM' + index('S14'), peer, health, 'OI' + index('S30')];
}
function mainEndingId(route, score) {
    if (!['C01', 'C02', 'C03', 'C04'].includes(route)) throw new Error('无效去向');
    if (route !== 'C01') return { C02: 'E07', C03: 'E08', C04: 'E09' }[route];
    return score >= 95 ? 'E01' : score >= 90 ? 'E02' : score >= 80 ? 'E03' : score >= 70 ? 'E04' : score >= 60 ? 'E05' : 'E06';
}
function endGame() {
    if (gameState.finalSnapshot) return;
    if (!gameState.events.includes('S35') || gameState.completedWeeks !== 52) throw new Error('尚未完成完整学年与考前剧情');
    gameState.finalSnapshot = {
        score: Math.round(Object.values(gameState.subjects).reduce((a, b) => a + b, 0) / 6),
        subjects: { ...gameState.subjects }, health: gameState.health, mental: gameState.mental,
        anxiety: gameState.anxiety, stress: gameState.stress
    };
    gameState.phase = 'postExam'; gameState.gameOver = true;
    document.querySelector('.actions').style.display = 'none';
    document.getElementById('actionCounter').style.display = 'none';
    renderPostExam();
    triggerStoryEvent(findNarrative('S36'));
    saveGame();
};
function finalRecord() {
    const f = gameState.finalSnapshot;
    return `<div class="final-score">${f.score}/100</div><p>本次成绩指数 · 游戏中的成长记录</p><p>${Object.entries(f.subjects).map(([k, v]) => `${subjectNames[k]} ${v.toFixed(1)}`).join(' · ')}</p>`;
}
function renderPostExam(route = null) {
    if (!gameState.finalSnapshot) return;
    if (gameState.finalRoute) { renderEnding(); return; }
    const main = document.querySelector('.main');
    const entry = route ? narrativeData.endings[route] : null;
    main.innerHTML = `<div class="end-screen"><h2>铃响以后</h2>${finalRecord()}${entry ? `<h3>${escapeText(entry.title)}</h3><div class="ending-text">${paragraphs(entry.content)}</div><button class="restart-btn" onclick="confirmRoute('${route}')">确认这个方向</button><button class="restart-btn" onclick="renderPostExam()">返回四项选择</button>` :
        `<p>先查看准备事项、代价与需要核实的支持，确认前可以自由返回。四项对所有成绩开放。</p>${['C01', 'C02', 'C03', 'C04'].map(id => `<button class="restart-btn" onclick="renderPostExam('${id}')">${escapeText(narrativeData.endings[id].title)}</button>`).join('')}`}
        ${!gameState.events.includes('S36') || gameState.narrativeFeedback ? '<button class="restart-btn" onclick="pumpNarrative()">继续考后剧情</button>' : ''}
        <button class="restart-btn" onclick="savePostExam()">先保存，稍后决定</button><p id="post-save-status"></p><button class="restart-btn" onclick="restartGame()">重新开始</button></div>`;
}
function savePostExam() {
    const okay = saveGame();
    document.getElementById('post-save-status').textContent = okay ? '已保存；去向仍未确认，稍后可继续查看全部方向。' : '本设备无法保存，请保持这个页面打开。';
}
function confirmRoute(route) {
    if (gameState.phase !== 'postExam' || !gameState.finalSnapshot || !gameState.events.includes('S36') || gameState.activeNarrative || gameState.narrativeFeedback) return;
    const id = mainEndingId(route, gameState.finalSnapshot.score);
    gameState.finalRoute = route; gameState.phase = 'ending';
    unlockAchievement('ending-' + id);
    saveGame(); renderEnding();
}
function renderEnding() {
    const id = mainEndingId(gameState.finalRoute, gameState.finalSnapshot.score);
    const ending = narrativeData.endings[id];
    const epilogues = chooseEpilogues();
    document.querySelector('.main').innerHTML = `<div class="end-screen"><h2>${escapeText(ending.title)}</h2>${finalRecord()}<div class="ending-text">${paragraphs(ending.content)}${epilogues.map(key => `<details class="epilogue" open><summary>${escapeText(narrativeData.endings[key].title)}</summary>${paragraphs(narrativeData.endings[key].content)}</details>`).join('')}</div><p>这份成绩与本次选择已保存。学校和项目均为虚构。</p><button class="restart-btn" onclick="restartGame()">重新开始</button></div>`;
}
openModal = function(id) {
    if (id === 'story-modal') { resumeNarrative(); return; }
    if (id === 'economy-modal' && !gameState.gameOver && !gameState.activeNarrative && !gameState.narrativeFeedback) {
        const duplicate = gameState.actionHistory.some(a => a.week === gameState.week && a.kind === 'view' && a.detail === 'materials');
        if (!duplicate) gameState.actionHistory.push({ week: gameState.week, kind: 'view', detail: 'materials' });
        if (!gameState.actionHistory.some(a => a.week === gameState.week && a.kind === 'view' && a.detail === 'course')) gameState.actionHistory.push({ week: gameState.week, kind: 'view', detail: 'course' });
        saveGame();
    }
    legacy.openModal(id);
};
initGame = function() {
    for (const n of [...narrativeData.stories, ...narrativeData.random]) {
        for (const c of n.choices) validateEffect(c.effect);
        if (n.commonEffect) validateEffect(n.commonEffect);
    }
    const restored = restoreGame();
    if (!restored) { legacy.initGame(); checkStageGoals(); saveGame(); }
    else {
        if (Array.isArray(gameState.schedule) && gameState.schedule.length) updateScheduleUI();
        else generateSchedule();
        // The saved log is text, so it never creates markup from a save file.
        for (const e of gameState.logHistory.slice().reverse()) legacyLog(e.text, e.type, typeof e.time === 'string' ? e.time : '此前记录');
        if (gameState.phase !== 'playing') {
            document.querySelector('.actions').style.display = 'none';
            document.getElementById('actionCounter').style.display = 'none';
            document.getElementById('welcome-modal').style.display = 'none';
            renderPostExam(); pumpNarrative(); return;
        }
        document.getElementById('welcome-modal').style.display = 'none';
    }
    updateUI();
    if (restored) pumpNarrative();
};
window.onload = initGame;
