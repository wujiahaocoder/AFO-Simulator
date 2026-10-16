/* Narrative integration for the classic, offline game.
 * Content is compiled separately; this file owns scheduling, evidence and final choices.
 */
"use strict";
const narrativeData = window.AFONarrative;
const subjectNames = { chinese: '语文', math: '数学', english: '英语', physics: '物理', chemistry: '化学', biology: '生物' };
const relationshipNames = { teacher: '班主任', mathTeacher: '数学老师', chineseTeacher: '语文老师', englishTeacher: '英语老师', classmateA: '同桌', classmateB: '旧队友', parents: '父母', crush: '林知夏' };
const effectNames = { ...subjectNames, ...relationshipNames, energy: '精力', stress: '压力', health: '健康', mental: '心理', anxiety: '焦虑', money: '金钱' };
const saveKey = window.AFODebugBoot?.enabled === true ? 'afo-debug-save-3.0.0' : 'afo-save-3.0.0';
// New fields are additive; existing 3.x saves keep the same local-storage key.
const saveVersion = '3.1.0';
const legacy = { initGame, updateUI, study, rest, exercise, takeExam, activity, economy, changeWeather, checkAchievements, checkHolidays, openModal, closeModal };
let actionInProgress = null;
let saveAvailable = true;

Object.assign(gameState, {
    daysLeft: 364, completedWeeks: 0, phase: 'playing',
    narrativeQueue: [], activeNarrative: null, narrativeFeedback: null,
    storyChoices: {}, memoryChoices: {}, actionHistory: [], examHistory: [],
    randomSeen: [], randomCountThisWeek: 0, lastNegativeWeek: {},
    deferredRandom: false, weekRandomAttempted: false, weekEnding: false,
    goalWeek: 5, goalResults: {}, goalDetails: {}, totalHomework: 0, totalIncome: 0,
    lowStressWeeks: 0, highEnergyWeeks: 0, finalSnapshot: null, finalRoute: null,
    romance: '暂不命名', mutualAffirmation: false, previousWeather: null,
    oldProgramAccess: false, practiceGoal: null, logHistory: [], negativeRandomThisWeek: false,
    reviewedExams: [], reviewPlan: null, studyGroupWeek: null, totalReviews: 0, totalStudyGroups: 0,
    sceneChoices: {}, missedScenes: {}, romanceHistory: [], wellbeingHistory: [], routePlans: {},
    homeworkSettledWeek: null, homeworkBacklog: [], homeworkHistory: [], goalClaims: {}
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
    return parts.join('，') || '无直接数值变化';
}
function metricSnapshot(state = gameState) {
    return Object.fromEntries(Object.keys(effectNames).map(key => [key,
        Object.hasOwn(subjectNames, key) ? state.subjects[key] : Object.hasOwn(relationshipNames, key) ? state.relationships[key] : state[key]]));
}
function actualMetricChange(before, state = gameState) {
    const after = metricSnapshot(state);
    return Object.fromEntries(Object.keys(before).filter(key => Math.abs(after[key] - before[key]) > 1e-9)
        .map(key => [key, Number((after[key] - before[key]).toFixed(2))]));
}
function actualChangeText(before, state = gameState) {
    const change = actualMetricChange(before, state);
    return Object.keys(change).length ? previewEffect(change) : '数值未变化（已达上下限）';
}
function saveGame() {
    try {
        const state = { ...gameState, achievements: [...gameState.achievements], currentGoal: null };
        localStorage.setItem(saveKey, JSON.stringify({ version: saveVersion, state }));
        saveAvailable = true;
        updateNarrativeStatus();
        return true;
    } catch (_) {
        saveAvailable = false;
        updateNarrativeStatus();
        return false;
    }
}
function restoreGame() {
    try {
        const saved = JSON.parse(localStorage.getItem(saveKey) || 'null');
        if (!saved || !['3.0.0', '3.0.1', '3.0.2', '3.1.0'].includes(saved.version)) return false;
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
        restoreNarrativeEvidence();
        gameState.homeworkBacklog = Array.isArray(s.homeworkBacklog) ? s.homeworkBacklog.filter(row =>
            row && Number.isInteger(row.week) && row.week > 0 && row.week <= s.week && Object.hasOwn(subjectNames, row.subject)) : [];
        gameState.homeworkHistory = Array.isArray(s.homeworkHistory) ? s.homeworkHistory.filter(row =>
            row && Number.isInteger(row.week) && Array.isArray(row.completed) && Array.isArray(row.missing) &&
            [...row.completed, ...row.missing].every(k => Object.hasOwn(subjectNames, k))) : [];
        gameState.homeworkSettledWeek = s.homeworkSettledWeek === s.week ? s.week : null;
        gameState.goalClaims = {};
        for (const [week, claim] of Object.entries(s.goalClaims || {})) {
            if (Object.hasOwn(stageGoals, week) && claim && Number.isInteger(claim.week) && claim.week > 0 && claim.week <= Number(week) &&
                typeof claim.actualReward === 'string' && Array.isArray(claim.requirements) &&
                claim.requirements.every(row => row && typeof row.text === 'string' && row.passed === true)) gameState.goalClaims[week] = claim;
        }
        gameState.reviewedExams = Array.isArray(gameState.reviewedExams) ? gameState.reviewedExams : [];
        if (gameState.reviewPlan && (!Array.isArray(gameState.reviewPlan.subjects) ||
            !gameState.reviewPlan.subjects.every(k => Object.hasOwn(subjectNames, k)) ||
            !Number.isInteger(gameState.reviewPlan.remaining) || gameState.reviewPlan.remaining < 0 || gameState.reviewPlan.remaining > 2 ||
            !Number.isInteger(gameState.reviewPlan.expiresWeek))) gameState.reviewPlan = null;
        const details = gameState.goalDetails;
        gameState.goalDetails = {};
        if (details && typeof details === 'object' && !Array.isArray(details)) {
            for (const [week, detail] of Object.entries(details)) {
                const validRows = rows => Array.isArray(rows) && rows.every(row => row && typeof row.text === 'string' && typeof row.passed === 'boolean');
                if (Object.hasOwn(stageGoals, week) && detail && detail.week === Number(week) &&
                    typeof detail.title === 'string' && typeof detail.achieved === 'boolean' &&
                    detail.achieved === gameState.goalResults?.[week] && typeof detail.rewardText === 'string' &&
                    validRows(detail.requirements) && detail.requirements.length && validRows(detail.challenges)) {
                    gameState.goalDetails[week] = detail;
                }
            }
        }
        clampState();
        checkStageGoals();
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
    claimStageGoal();
    legacy.updateUI();
    const total = document.getElementById('achievement-total');
    if (total) total.textContent = Object.keys(achievements).length;
    updateNarrativeStatus();
    const plan = document.getElementById('review-plan-status');
    if (plan) plan.textContent = activeReviewPlan() ? `复盘提示 · ${gameState.reviewPlan.subjects.map(k => subjectNames[k]).join('、')} · 还可巩固 ${gameState.reviewPlan.remaining} 次` : '';
    document.getElementById('average-value').textContent = `均分 ${(Math.floor(stageAverage(gameState) * 100) / 100).toFixed(2)}`;
    document.getElementById('homework-backlog').textContent = gameState.homeworkBacklog.length;
    const remaining = Object.values(gameState.homework).filter(done => !done).length;
    document.querySelector('.weekend-note').textContent = remaining ? `本周作业需${remaining * 5}精力，不占行动` : '本周作业已安排，不占行动';
};
function updateNarrativeStatus() {
    const status = document.getElementById('game-status');
    if (status) status.textContent = gameState.phase === 'ending' ? '这一年的记录已封存。' :
        gameState.phase === 'postExam' ? '考试已结束，考后去向待确认。' : gameState.weekEnding ? '周末 · 作业与故事' : '安排好本周，故事会在周末继续。';
    const info = document.getElementById('narrative-status');
    if (info) info.textContent = `主线 ${gameState.storyProgress}/36 · 学习效率 ${calculateStudyEfficiency().toFixed(2)} · ${saveAvailable ? '已自动保存' : '本设备无法保存，请保持页面打开'}`;
    const resume = document.getElementById('narrative-label');
    if (resume) resume.textContent = gameState.weekEnding || gameState.activeNarrative || gameState.narrativeFeedback || gameState.narrativeQueue.length ? '继续阅读' : '蓝本';
}
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
    const beforeMoney = gameState.money;
    actionInProgress = { kind, detail };
    try { action(); } finally { actionInProgress = null; }
    if (gameState.actionsThisWeek === count) return;
    legacy.closeModal('story-modal');
    if (gameState.money > beforeMoney) gameState.totalIncome += gameState.money - beforeMoney;
    if (kind === 'rest' && detail === 'counseling') gameState.actionHistory.at(-1).support = true;
    clampState();
    updateUI();
    saveGame();
    // Random scenes, like story scenes, wait for the weekend.
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
function homework(action) { settleWeekendHomework(action); }
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
    const before = metricSnapshot();
    performAction('exam', null, legacy.takeExam);
    if (gameState.examCount !== count) {
        reviewExam(gameState.examHistory.length - 1);
        const exam = gameState.examHistory.at(-1);
        showMenu('模考与复盘', `成绩指数 ${exam.score}/100。\n\n${Object.entries(exam.subjects).map(([k,v]) => `${subjectNames[k]} ${v}`).join(' · ')}\n\n整次行动净变化：${actualChangeText(before)}。\n\n复盘已核对${gameState.reviewPlan.subjects.map(k => subjectNames[k]).join('、')}，各最多 +3；复盘部分压力最多 -5、焦虑最多 -6。以上整次净变化还包括考试消耗与成绩反馈。后续两次相关科目的独立学习 +20%。考试与复盘共用一次行动、40精力。`,
            [{ text: '收好试卷', action: () => closeModal('story-modal') }]);
        saveGame();
    }
};
function showStudyMenu() {
    if (!checkActionLimit()) return;
    const costs = { chinese: 25, math: 35, english: 25, physics: 35, chemistry: 20, biology: 20 };
    showMenu('学习', '独立练习或找人核对问题，都占一次行动。',
        Object.keys(subjectNames).map(k => ({ text: `${subjectNames[k]} · ${costs[k]}精力`, action: () => study(k) })).concat(
            [{ text: '与人共学 · 选择伙伴（20精力）', action: () => studyTogether() }]));
}
function showExamMenu() {
    if (!checkActionLimit()) return;
    showMenu('模考', `已参加 ${gameState.examCount}/5 次。考试与复盘一起完成：一次行动、40精力，健康至少60。复盘会留下两门薄弱科目的学习提示。`,
        [{ text: '开始模考并复盘', disabled: gameState.examCount >= 5 || gameState.energy < 40 || gameState.health < 60, action: takeExam }, { text: '返回', action: () => closeModal('story-modal') }]);
}
function showMenu(title, text, entries) {
    elements.storyTitle.textContent = title;
    elements.storyContent.innerHTML = paragraphs(text);
    elements.storyChoices.innerHTML = '';
    for (const entry of entries) {
        const button = document.createElement('button');
        button.className = 'story-choice-btn';
        button.textContent = entry.text;
        button.disabled = !!entry.disabled;
        button.onclick = entry.action;
        elements.storyChoices.appendChild(button);
    }
    document.getElementById('story-modal').style.display = 'flex';
    const panel = document.querySelector('#story-modal .modal-content');
    if (panel) panel.scrollTop = 0;
}
function social(target) {
    if (!target) {
        if (!checkActionLimit()) return;
        showMenu('这次想和谁交流？', '消耗一次行动、15精力；健康至少50。关系改善只属于本次选择的对象。',
            Object.entries(relationshipNames).map(([key, name]) => ({ text: `${name} · 熟悉${Math.floor(gameState.relationships[key])}`, action: () => social(key) })));
        return;
    }
    if (!Object.hasOwn(relationshipNames, target) || !checkActionLimit()) return;
    if (gameState.energy < 15 || gameState.health < 50) { showNotification('社交需要15精力，健康至少50。', 'neutral'); return; }
    performAction('social', target, () => {
        const before = metricSnapshot();
        const bonus = [5, 8, 3, 4][Math.floor(Math.random() * 4)];
        const stress = [-5, -3, 5, -8][Math.floor(Math.random() * 4)];
        applyEffect({ energy: -15, stress: -10 + stress, anxiety: -5, [target]: 5 + bonus });
        gameState.totalSocialHours++;
        addToLog(`与${relationshipNames[target]}交流：${socialContext(target)} 实际变化：${actualChangeText(before)}。`, 'good');
        closeModal('story-modal');
        recordAction(); advanceTime();
    });
};
function socialContext(target) {
    const again = gameState.actionHistory.filter(a => a.kind === 'social' && a.detail === target).length % 2;
    if (target === 'parents') return gameState.events.includes('S12') ? '你提起饭桌上那次谈话，先问今天方便分享哪件小事；这次闲谈不替代尚未落实的约定。' : again ? '你们各自说起今天的一件小事，暂时把成绩单留在旁边。' : '你聊起今天的饭菜，也听家里分享近况。';
    if (target === 'crush') return gameState.events.includes('S24') ? '你先问她今天愿意分享什么，聊起采访之外的近况；这次交流没有替双方改变已经说清的关系范围。' : again ? '你们分享今天路上看到的小事，没有把一次闲谈写成未来承诺。' : '你问起她最近留意的校园声音，也说起自己听见的一小段。';
    if (target === 'classmateB') return sceneChoice('H13') ? '你问候他自己选的新安排，分享今天的一件小事，没有要求恢复从前的联系频率。' : '你们聊起训练以外的生活，也各自说了一件本周的新鲜事。';
    if (target === 'classmateA') return chose('H11', 'A') ? '你提到修车台留下的合照，又问起今天课间的小事；下次安排仍要另外说清。' : again ? '你们各自讲了一件课间的小事，听完再回到今天的安排。' : '你们聊起午饭和课间见闻，先问彼此今天哪段时间方便。';
    const topic = { teacher: '这周的安排', mathTeacher: '数学课', chineseTeacher: '最近读过的句子', englishTeacher: '英语课上的表达' }[target];
    return `你从${topic}聊起，先问老师什么时候方便继续；问候不等于完成尚待核对的学习任务。`;
}
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
    const reviews = availableReviews();
    if (index === undefined) return showExamMenu();
    const match = reviews.find(r => r.index === index);
    if (!match || gameState.finalSnapshot) return;
    const subjects = Object.keys(subjectNames).sort((a, b) => match.exam.subjects[a] - match.exam.subjects[b]).slice(0, 2);
    applyEffect({ stress: -5, anxiety: -6, ...Object.fromEntries(subjects.map(k => [k, 3])) });
    gameState.reviewedExams.push(index);
    gameState.reviewPlan = { subjects, remaining: 2, expiresWeek: Math.min(52, gameState.week + 3) };
    gameState.totalReviews++;
    gameState.actionHistory.push({ week: gameState.week, kind: 'review', detail: String(index), subjects, integrated: true });
    addToLog(`模考后核对${subjects.map(k => subjectNames[k]).join('、')}，各 +3；已留下后续练习提示。`, 'good');
    updateUI(); saveGame();
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
        const partners = Object.keys(relationshipNames).filter(k => groupSubjects(k).length);
        showMenu('与谁共学？', '每周一次：一次行动、20精力，健康至少50，熟悉程度至少60。同学可讨论六科，老师只辅导任教学科。',
            partners.map(k => ({ text: `${relationshipNames[k]} · 熟悉 ${Math.round(gameState.relationships[k])}/60 · ${groupSubjects(k).length === 6 ? '六科' : groupSubjects(k).map(x => subjectNames[x]).join('、')}${gameState.relationships[k] < 60 ? '（暂未解锁）' : ''}`, disabled: gameState.relationships[k] < 60, action: () => studyTogether(k) })).concat(
                [{ text: '返回学习', action: showStudyMenu }]));
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
        applyEffect({ energy: -20, stress: -4, anxiety: -studyBalance.groupAnxietyReduction, [target]: 2, [subject]: gain });
        gameState.studyGroupWeek = gameState.week;
        gameState.totalStudyGroups++;
        addToLog(`与${relationshipNames[target]}一起核对${subjectNames[subject]}教材，能力 +${gain.toFixed(1)}；今天各自仍有要继续做的部分。`, 'good');
        closeModal('story-modal'); recordAction(); advanceTime();
        gameState.actionHistory.at(-1).partner = target;
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
    if (!gameState.weekEnding) { gameState.deferredRandom = true; return; }
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
        (n.revision ? sceneRequirementsMet(n) : n.id === 'H06' ? Object.values(gameState.subjects).some(v => v < 40) : gameState.events.includes(entry[n.id])));
}
function availableWeeklyStories() {
    return [...dueMainStories(), ...availableSideStories()];
}
function resumeNarrative() {
    if (gameState.phase !== 'playing') { renderPostExam(); pumpNarrative(); return; }
    if (gameState.narrativeFeedback || gameState.activeNarrative || gameState.narrativeQueue.length) { pumpNarrative(); return; }
    if (gameState.weekEnding) { continueWeekEnd(); return; }
    showPromiseLedger();
}
function promiseRecords(state = gameState) {
    const lines = lineResults(state);
    return (narrativeData.promises || []).filter(entry => state.events.includes(entry.setup) && entry.keys.includes(sceneChoice(entry.setup, state))).map(entry => {
        const result = findNarrative(entry.result);
        const key = sceneChoice(entry.result, state);
        const answered = state.events.includes(entry.result) && result.choices.some(c => c.key === key);
        const missed = state.missedScenes?.[entry.result] === result.until;
        const week = state.sceneChoices[entry.setup].week;
        let status, detail;
        if (missed) { status = '期限已过'; detail = result.missedFeedback; }
        else if (answered) {
            status = lines[entry.line] ? '已经落空' : '已有答复';
            detail = state.sceneChoices[entry.result]?.feedback || '旧记录只保留当时的回应：' + narrativeChoiceText(result, result.choices.find(c => c.key === key), narrativeVariant(result, state));
        } else if (state.week > result.until) {
            status = '暂无答复记录'; detail = '这页没有留下最后的答复，先把这一处留空。';
        } else {
            status = state.week < result.week ? '等候后续' : '尚待答复';
            const knownDate = { H10: '已约定第42周星期六下午三点到修车台合照。', H16: '已提到最晚第44周约谈。', H33: '店主说最晚第49周给出最后答复。' }[entry.setup];
            detail = knownDate ? knownDate + '这页保留约定，实际答复仍需等后续。' : '约定还在等答复；有新的消息时会在周末继续。';
        }
        return { id: entry.setup, title: entry.title, week, status, detail };
    }).sort((a, b) => a.week - b.week);
}
function showPromiseLedger() {
    if (gameState.phase !== 'playing') return false;
    if (gameState.activeNarrative || gameState.narrativeFeedback || gameState.narrativeQueue.length || gameState.weekEnding) { pumpNarrative(); return false; }
    const records = promiseRecords();
    const text = (records.length ? '这里只记下你实际提起过的事与已经得到的答复。已经落空的，不会因为后来成绩或熟悉程度变好就自动消失。' : '蓝本里还没有记下具体的牵挂。剧情中实际提起并接下的事会记在这里；没有提起过的，不会替你补写成失约或失去。') + '\n\n查看蓝本不消耗行动。';
    showMenu('蓝本里的牵挂', text, [{ text: '收好蓝本', action: () => closeModal('story-modal') }]);
    elements.storyContent.innerHTML += records.map(row => `<section class="promise-record"><h4>${escapeText(row.title)} · ${escapeText(row.status)}</h4><p>${escapeText(row.detail)}</p></section>`).join('');
    return true;
}
function triggerStoryEvent(node) {
    if (gameState.events.includes(node.id)) return;
    if (node.kind === 'memory' && (gameState.energy < 10 || gameState.actionsThisWeek >= 3)) { showNotification('回忆需要10精力和一次行动。', 'neutral'); return; }
    if (!gameState.narrativeQueue.includes(node.id) && gameState.activeNarrative !== node.id) gameState.narrativeQueue.push(node.id);
    pumpNarrative();
};
function checkHiddenEvents() { /* Eligible side scenes are scheduled at the weekend. */ };
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
        if (node.id === 'S22' && c.key === 'A') {
            const original = practiceGoalSubjects(state);
            if (original.length) allowed = original;
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
function practiceGoalSubjects(state = gameState) {
    const recorded = state.practiceGoal?.subjects || state.storyChoices.S18?.targets || [];
    if (!Array.isArray(recorded)) return [];
    return [...new Set(recorded.filter(k => Object.hasOwn(subjectNames, k)))];
}
function practiceAttempts(state = gameState) {
    const subjects = practiceGoalSubjects(state), week = state.practiceGoal?.week || state.storyChoices.S18?.week;
    return subjects.length && week ? state.actionHistory.filter(a => a.week >= week && a.week < state.week && a.kind === 'study' && subjects.includes(a.detail)).length : 0;
}
function narrativeVariant(node, state = gameState) {
    if (!node.variants) return null;
    if (node.id === 'S30') {
        const archive = chose('H25', 'A', state) ? 'closed' : chose('H25', 'C', state) ? 'withdrawn' : chose('H25', 'B', state) ? 'moved' : chose('H24', 'A', state) ? 'scheduled' : null;
        return node.variants[archive] || null;
    }
    if (['M02', 'M04'].includes(node.id)) {
        const contact = lineResults(state).team ? 'distant' : chose('H13', 'C', state) ? 'occasional' : null;
        return node.variants[contact] || null;
    }
    const key = hasRomanceEvent('rejected', state) ? 'refused' : state.romance === '明确互相喜欢' && state.mutualAffirmation ? 'dating' : state.romance === '朋友' ? 'friends' : 'growing';
    return node.variants[key] || null;
}
function narrativeChoiceText(node, c, variant = narrativeVariant(node)) {
    return variant?.choices?.[c.key]?.text || c.text;
}
function renderStoryContent(node) {
    let text = narrativeVariant(node)?.content || node.content;
    const choice = id => gameState.storyChoices[id]?.key;
    const source = { A: '作业单', B: '页码小框', C: '夹在最前面的课表' }[choice('S01')] || '课表';
    text = text.replace('{familyCallback}', { A: '对方带来那张三栏汇报页，纸边仍有一个分数问号。', B: '对方先问今天是不是约好的谈话时间。', C: '对方带来给班主任的提问草稿，里面有两条还没问清楚。' }[choice('S03')] || '对方只问：“现在方便聊吗？”');
    text = text.replace('{conditionCallback}', (gameState.health < 45 || gameState.energy < 25 ? '你坐下后才发现自己一直揉着眼睛，今天需要为必要的休息留位置。' : '你看见同桌收起书，自己的计划里也需要留空。') + (gameState.anxiety >= 65 || gameState.stress >= 75 ? '你把安排看了三遍，仍担心漏掉什么。' : ''));
    text = text.replace('{examCallback}', examTrend());
    text = text.replace('{peerCallback}', peerInteractionCount() >= 2 ? '几次实际交流给你们留了能记起的话题，有些话已不必借一道题开头。' : '你们有过几次交谈，还没有许多一起度过的时间。你发觉自己在等一个顺便说话的时机。');
    text = text.replace('{teamConversation}', chose('H12', 'B') ? '你想起自己把他的感受说轻的那句话，仍有机会解释。' : '上次你认真听过他的遗憾，他却也说想把下一段生活和旧队伍分开。你们的距离不全是一场误会造成的。');
    text = text.replace('{teacherConversation}', chose('H16', 'A') ? '你按约得到过一般材料建议，期待的系统方向专门咨询却收到可能取消的通知。' : '你想谈的方向仍写在蓝本上，还没有约上这一轮面谈。');
    if (node.id === 'S07') text = text.split('按实际记录显示一段：')[0] + '\n\n' + examTrend();
    if (node.id === 'S12') text = text.replace(/若 S03[\s\S]*?当时的气话。/, ({ A: '对方问起约好的简短汇报，你指着纸上仍待核实的问号。', B: '对方问是不是到了约定谈话的时间。', C: '对方问起准备交给班主任的提问草稿，仍需核实的事留在纸上。' }[choice('S03')] || '对方只问：“现在方便聊吗？”'));
    if (node.id === 'S22') {
        text = text.split('先读目标的真实记录')[0];
        const subjects = practiceGoalSubjects(), attempts = practiceAttempts();
        text += '\n\n' + (subjects.length ? `原目标科目是${subjects.map(k => subjectNames[k]).join('、')}。` : '原记录没有留下具体目标科目，今天先确定一个可核对的入口。') +
            (attempts ? `实际记录里有${attempts}次这些科目的学习尝试。它能说明投入发生过，是否独立掌握仍需在练习里核实。` : '这一栏还没有可核对的后续学习记录，先检查材料，再缩小问题。') + '\n\n' + examTrend();
    }
    if (node.id === 'S23') text = text.replace(/如果 S09 未发生[\s\S]*?。/, choice('S09') ? '' : '他补了一句：“现在的声音比刚修时有底气一点。”');
    if (node.id === 'S25') text = text.replace(/你们翻回 S05 的材料。[\s\S]*?用今天这份练笔。/, `你们翻回${choice('S05') === 'A' ? '食堂托盘与汤渍的观察' : choice('S05') === 'C' ? '叶片朝向的观察' : '今天这份练笔'}，从真实留下的句子继续看。`);
    if (node.id === 'S29') text = text.split('按实际材料呈现：')[0] + '\n\n' + examTrend();
    if (node.id === 'S34') text = text.split('S03、S21')[0] + '\n\n' + (gameState.relationships.parents < 50 ? '你们说话仍容易绕回旧争论，于是先只谈一项。' : '你们已经知道哪些话题需要先问是否方便。') + '哪些费用能够承担，仍要逐项核实。';
    if (node.id === 'S35') text = text.split('读取真实状态：')[0] + '\n\n' + (gameState.health < 45 ? '必要的身体照护先放在前面，其他事情可以分开处理。' : gameState.anxiety >= 65 || gameState.stress >= 75 ? '手机每一次亮屏都让你想伸手。今晚只先处理能确认的一小段。' : '你有余力整理桌面，把必要的东西留在手边。') + `\n\n蓝本里仍留着第一天的${source}。`;
    const refs = { S03: '之前家里谈话', S07: '之前留下的学习页', S08: '通知栏试做', S10: '那次互助', S12: '之前饭桌谈话', S16: '小群约定', S18: '之前记录', S19: '限时练习', S22: '练习核对', S24: '之前在校门口的', S25: '修改过的练笔', S26: '课堂尝试', S29: '复做页' };
    text = text.replace(/S\d{2}/g, id => refs[id] || '之前的那次选择');
    if (['S02', 'S06', 'S09', 'S13', 'S16', 'S18', 'S19', 'S21', 'S23', 'S26', 'S31', 'S32', 'S33', 'S36'].includes(node.id)) {
        const callbacks = {
            S02: `蓝本旁还放着第一天留下的${source}。`,
            S06: { A: '你翻回上次留下的一题样本。', B: '那张互圈纸还夹在课表边。', C: '你拿出了写着对象、条件、单位、结论的检查卡。' }[choice('S02')],
            S09: '这次可以聊修车、做饭和各自的安排，朋友的生活不只有功课。',
            S13: '你知道可以主动联系原教练，也可以今天先停在这里。',
            S31: '蓝本里可以找到之前留下的范围和安排；没有核实的项目仍留白。',
            S36: `收拾时，你又看见第一天的${source}。`
        };
        if (callbacks[node.id]) text += '\n\n' + callbacks[node.id];
    }
    return text.trim();
}
function choiceFeedback(node, c, variant = null) {
    if (variant?.choices?.[c.key]?.feedback) return variant.choices[c.key].feedback;
    if (node.id === 'S22' && c.key === 'A') return `你保留原来的页码，把这次能检验的${(c.targets || practiceGoalSubjects()).map(k => subjectNames[k]).join('、')}问题写清。${practiceAttempts() ? '已有的学习记录留在旁边，今天再独立试一处。' : '尚无可核对的后续练习，今天从最小入口开始。'}是否掌握仍按这次实际练习核实，不必换一本新本子来给自己另一个开头。`;
    if (node.id === 'H17' && c.key === 'A') return chose('H16', 'A') ? '专门咨询最终取消，班主任给过一般材料建议，也尝试联系原定的方向老师，没能补开名额。你按约准备过，期待的那轮专门指导仍没有得到。' : '你在截止前完成预约，老师读过你的一页方向问题，给了具体材料反馈。这轮机会确实发生了。';
    if (node.id === 'H08' && c.key === 'A') {
        if (hasRomanceEvent('rejected')) return '你把喜欢说清，她认真回答：“我很珍惜你，但没有同样的感情。我想继续做采访伙伴，不想建立恋爱关系。”你听见了她的拒绝；之前的帮忙没有换来同样的喜欢。';
        if (hasRomanceEvent('mutual')) return '你们从录音里的笑声说到彼此等消息的心情。她亲口说“我喜欢你”，你也明确回应了同样的喜欢。她仍想去做社区采访，你们没有因此替对方改掉计划。';
        return '你们把上次的分歧说清。她说自己更愿意按朋友的方式继续认识你。没有人把一次好好沟通当成已经确认恋爱。';
    }
    if (node.id === 'S33') {
        if (gameState.romance === '已结束') return '她说：“我们确实喜欢过，但我不想继续一段总在为陪伴时间道歉的关系。”你们回顾已经试过的安排，明确结束恋爱。这段喜欢成立过，结束也已经发生。';
        if (hasRomanceEvent('rejected')) return gameState.romance === '被拒后朋友' ? '她没有改变之前的回答。你们另外确认愿意按朋友的范围联系，被拒的事实没有被这次友谊覆盖。' : '她明确说没有同样的喜欢，不愿建立恋爱关系。你听完，接受了这个回答，之后减少单独联系。';
        if (gameState.romance === '明确互相喜欢') return gameState.romanceHistory.some(e => e.type === 'mutual' && e.scene === 'H08') ?
            '她提起一起改稿、说清分歧的那几次相处，亲口说仍然喜欢你，你也明确回应。你们愿意继续这段关系，各自的采访和生活安排仍需要商量。' :
            '她提起一起改稿、聊起各自生活的那几次相处，说：“现在我知道，我喜欢你。”你明确回应同样的喜欢。这是你们第一次把彼此的回答说清，之后的安排仍需要一起商量。';
        if (gameState.romance === '慢慢了解') return '你表达仍愿意走近。她说还没有足够的共同经历来确认同样的喜欢，愿意继续慢慢了解。你们说好有想分享的事情再联系，今天先各自回家。';
        return c.key === 'B' ? '你们重新谈清朋友的范围，双方都答应按愿意分享的事情联系。她讲起下一次采访，问你附近那家小店有没有重新开门。' : '你们暂时不命名关系。她说明自己会继续采访与生活，也没有承诺等待一个未来答案。';
    }
    if (node.id === 'S36') return { A: '成绩已经留在蓝本里。你先了解升学方向，也可以返回比较其他安排。', B: '升学、复读、休整、工作与继续学习同时开放，确认前可以自由返回。', C: '今天先吃一顿不必卡着下课铃的饭。去向仍未确认，回来后可继续查看全部方向。' }[c.key];
    return c.feedback.replace(/S\d{2}/g, '之前的那次选择');
}
// Select an actual authored branch from current abilities, state and recorded actions.
// No hidden random draw or relationship score alone creates a romance choice.
function automaticMainChoice(node, state = gameState) {
    const low = state.energy < 35 || state.health < 55;
    const burden = state.anxiety >= 45 || state.stress >= 55;
    const socialStudy = state.actionHistory.some(a => a.week >= state.week - 3 && ['social', 'studyGroup'].includes(a.kind));
    const recentStudy = state.actionHistory.some(a => a.week >= state.week - 3 && a.kind === 'study');
    const average = Object.values(state.subjects).reduce((a,b) => a+b, 0) / 6;
    const r = state.relationships;
    const preferred = {
        S01: burden ? 'C' : r.classmateA >= r.teacher ? 'A' : 'B',
        S02: socialStudy && r.classmateA >= 60 ? 'B' : r.mathTeacher >= 60 ? 'A' : 'C',
        S03: burden ? 'B' : r.parents >= 50 ? 'A' : 'C',
        S04: burden ? 'B' : r.classmateB >= 55 ? 'A' : 'C',
        S05: r.crush >= 40 && socialStudy ? 'B' : state.subjects.chinese < 20 ? 'A' : 'C',
        S06: socialStudy ? 'B' : sceneChoice('S02', state) === 'A' ? 'A' : 'C',
        S07: average < 40 ? 'A' : state.examHistory.length ? 'B' : 'C',
        S08: low || burden ? 'C' : socialStudy ? 'B' : 'A',
        S09: state.subjects.physics < state.subjects.math ? 'A' : state.subjects.english < 30 ? 'C' : 'B',
        S10: socialStudy && r.classmateA >= 55 ? 'A' : r.teacher >= 60 ? 'B' : 'C',
        S11: burden ? 'B' : state.subjects.english < 30 ? 'C' : 'A',
        S12: burden ? 'B' : r.parents >= 60 ? 'C' : 'A',
        S13: state.memoryCount > 0 ? 'B' : r.classmateB >= 55 ? 'A' : 'C',
        S14: burden ? 'B' : r.classmateB >= 55 ? 'A' : 'C',
        S15: Math.abs(state.subjects.chemistry - state.subjects.biology) < 8 ? 'C' : state.subjects.chemistry < state.subjects.biology ? 'A' : 'B',
        S16: low || burden ? 'C' : socialStudy ? 'B' : 'A',
        S17: r.crush >= 60 && socialStudy ? 'A' : r.crush >= 35 ? 'B' : 'C',
        S18: recentStudy ? 'A' : state.examHistory.length ? 'B' : 'C',
        S19: burden ? 'C' : socialStudy ? 'B' : 'A',
        S20: low ? 'C' : burden ? 'A' : 'B',
        S21: state.money < 200 ? 'B' : r.parents < 45 ? 'C' : 'A',
        S22: recentStudy ? 'A' : burden ? 'C' : 'B',
        S23: r.classmateB < 45 ? 'C' : recentStudy ? 'A' : 'B',
        // Friendship and explicitly recorded interest persist; familiarity is never consent.
        S24: r.crush >= 65 && state.actionHistory.filter(a => a.kind === 'social' && a.detail === 'crush' || a.kind === 'studyGroup' && a.partner === 'crush').length >= 2 ? 'A' : r.crush >= 35 ? 'B' : 'C',
        S25: state.subjects.english < state.subjects.chinese ? 'B' : state.subjects.chinese < 50 ? 'A' : 'C',
        S26: socialStudy && r.classmateB >= 60 ? 'B' : state.subjects.physics < 55 ? 'A' : 'C',
        S27: low ? 'A' : burden ? 'B' : 'C',
        S28: r.classmateB < 45 ? 'C' : burden ? 'B' : 'A',
        S29: average < 60 ? 'A' : burden ? 'C' : 'B',
        S30: state.memoryCount > 0 || state.oldProgramAccess ? 'A' : burden ? 'C' : 'B',
        S31: state.money < 200 ? 'C' : average >= 60 ? 'A' : 'B',
        S32: Math.min(state.subjects.chinese, state.subjects.english) < 50 ? 'A' : socialStudy ? 'C' : 'B',
        S33: hasRomanceEvent('mutual', state) || hasRomanceEvent('rejected', state) || state.romance === '慢慢了解' ? 'A' : state.romance === '朋友' ? 'B' : 'C',
        S34: r.parents >= 60 ? 'A' : r.parents >= 40 ? 'B' : 'C',
        S35: low ? 'A' : burden ? 'C' : 'B', S36: 'B'
    }[node.id];
    const options = resolveChoices(node, state).filter(c => (c.effect.money || 0) >= -state.money);
    const candidates = options.filter(c => c.key === preferred);
    const pool = candidates.length ? candidates : options;
    return pool.slice().sort((a,b) => {
        const need = c => (c.targets || []).reduce((sum,k) => sum + 100 - state.subjects[k], 0);
        return need(b) - need(a);
    })[0];
}
function routedSideStories() {
    return availableSideStories().filter(node => {
        // Follow-ups keep their actual prerequisite choices. New introductions also use the panel.
        if (node.requires?.some(r => r.id.startsWith('H'))) return true;
        const r = gameState.relationships;
        const gates = {
            H01: r.classmateB >= 55 || gameState.memoryCount > 0,
            H02: r.parents < 60 || gameState.stress >= 40,
            H03: r.classmateB >= 55, H04: r.teacher >= 55,
            H05: r.crush >= 35, H07: r.crush >= 40,
            H12: r.classmateB >= 50, H14: r.parents >= 50,
            H16: r.teacher >= 55, H18: gameState.totalStudyHours >= 8,
            H20: gameState.subjects.chinese >= 25, H22: gameState.subjects.english >= 20,
            H24: gameState.memoryCount > 0 || r.classmateB >= 60,
            H26: gameState.health >= 50, H28: stageAverage(gameState) >= 50,
            H29: r.classmateB >= 55, H31: r.classmateA >= 55,
            H33: r.classmateB >= 50, H35: gameState.subjects.math >= 15,
            H37: r.classmateA >= 55, H39: r.crush >= 35,
            H41: r.parents >= 40, H43: r.classmateA >= 50,
            H45: gameState.stress >= 25 || gameState.totalStudyHours >= 5
        };
        return gates[node.id] !== false;
    });
}
function mainResponseSentence(node, c, variant) {
    const raw = narrativeChoiceText(node, c, variant);
    const targets = c.targets?.map(k => subjectNames[k]).join('、');
    const response = /^你/.test(raw) ? raw : `你${raw.replace(/^选择/, '选择了').replace(/^选(?=[一两])/, '选了')}`;
    return response + (targets ? `\n\n这次处理的科目是${targets}。` : '');
}
function showNarrative(node) {
    if (node.kind === 'main') {
        const c = automaticMainChoice(node);
        if (!c) throw new Error('没有可进入的主线分支：' + node.id);
        commitNarrativeChoice(node, c, true);
        return;
    }
    const entries = node.choices.map(c => ({
        text: `${narrativeChoiceText(node, c)}\n${previewEffect(c.effect)}${c.target ? c.target === 'lastStudy' ? `；本周最近一次主动学习科目 +${c.targetGain}` : `；另选科目，总能力 +${c.targetGain ?? 1.2}` : ''}`,
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
    showMenu(node.title, renderStoryContent(node), entries);
    if (node.commonEffect || node.cost) {
        elements.storyContent.innerHTML += `<p class="narrative-note">${node.commonEffect ? '本学段课堂练习与整理：六科各 +0.2；' : ''}${node.cost ? '确认后：一次行动，精力 -10，焦虑 -2；' : '本段不消耗常规行动；'}选择效果见下方。</p>`;
    }
    // Disable costs before clicking as well as validating them again at settlement.
    Array.from(elements.storyChoices.children).forEach((button, i) => {
        const c = node.choices[i];
        if (c && (c.effect.money || 0) < -gameState.money) { button.disabled = true; button.textContent += '（余额不足）'; }
    });
}
function commitNarrativeChoice(node, c, automatic = false) {
    if (gameState.activeNarrative !== node.id || gameState.events.includes(node.id) || gameState.randomSeen.includes(node.id)) return false;
    if (gameState.finalSnapshot && node.id !== 'S36') return false;
    if ((c.effect.money || 0) < -gameState.money) return false;
    if (node.kind === 'memory' && (gameState.actionsThisWeek >= 3 || gameState.energy < 10)) return false;
    const variant = narrativeVariant(node);
    const sceneText = automatic ? renderStoryContent(node) : null;
    const selectedText = narrativeChoiceText(node, c, variant);
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
        if (node.kind === 'side') {
            gameState.sceneChoices[node.id] = record;
            gameState.actionHistory.push({ week: gameState.week, kind: 'side', detail: node.id });
        }
    }
    recordRomanceOutcome(node, c);
    if (node.id === 'S18') gameState.practiceGoal = { week: gameState.week, subjects: c.targets?.length ? c.targets : Object.keys(subjectNames) };
    gameState.activeNarrative = null;
    const feedbackText = choiceFeedback(node, c, variant);
    if (node.kind === 'side') record.feedback = feedbackText;
    const finishShortEvent = node.kind === 'random' && !feedbackText.trim();
    gameState.narrativeFeedback = finishShortEvent ? null : { title: node.title,
        text: automatic ? `${sceneText}\n\n${mainResponseSentence(node, c, variant)}\n\n${feedbackText}` : feedbackText,
        postChoice: node.id === 'S36' ? c.key : null };
    if (finishShortEvent) closeModal('story-modal');
    addToLog(`${node.title}：${selectedText}${c.targets?.length ? '（' + c.targets.map(k => subjectNames[k]).join('、') + '）' : ''}`, 'story');
    if (gameState.phase === 'playing') { checkAchievements(); updateUI(); }
    updateNarrativeStatus();
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
    updateNarrativeStatus();
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
    // During the week, pending events stay deferred until endWeek.
}
function endWeek() {
    if (gameState.phase !== 'playing') return;
    if (gameState.weekEnding || gameState.activeNarrative || gameState.narrativeFeedback) { pumpNarrative(); return; }
    if (gameState.actionsThisWeek < 3 && !confirm(`本周还有${3 - gameState.actionsThisWeek}次行动机会，确定结束本周吗？`)) return;
    closeModal('story-modal');
    gameState.weekEnding = true;
    saveGame();
    continueWeekEnd();
};
function weekendHomeworkPlan(action, state = gameState) {
    const missing = Object.keys(subjectNames).filter(k => !state.homework[k]);
    const complete = action === 'complete-one' ? missing.slice().sort((a,b) => state.subjects[a] - state.subjects[b]).slice(0,2) :
        ['complete-all', 'complete-and-repay'].includes(action) ? missing : [];
    const repay = action === 'complete-and-repay' ? state.homeworkBacklog.slice(0,2) : [];
    const uncompleted = missing.filter(k => !complete.includes(k)), fraction = uncompleted.length / 6;
    const energy = (complete.length + repay.length) * 5;
    const effects = [{ energy: -energy }, ...complete.map(k => ({ [k]: 0.5 }))];
    if (complete.length) effects.push({ teacher: complete.length / 2, mathTeacher: complete.includes('math') ? 2 : 0,
        chineseTeacher: complete.includes('chinese') ? 2 : 0, englishTeacher: complete.includes('english') ? 2 : 0, anxiety: -complete.length / 3 });
    effects.push(...repay.map(row => ({ [row.subject]: 0.3, teacher: 1 })));
    if (uncompleted.length) effects.push({ teacher: -5 * fraction, mathTeacher: uncompleted.includes('math') ? -3 : 0,
        chineseTeacher: uncompleted.includes('chinese') ? -3 : 0, englishTeacher: uncompleted.includes('english') ? -3 : 0,
        energy: 8 * fraction, stress: -3 * fraction, anxiety: 2 * fraction });
    const before = metricSnapshot(state), projected = { ...before };
    for (const effect of effects) {
        if (state.finalSnapshot || (effect.money || 0) < -projected.money) continue;
        for (const [key, amount] of Object.entries(effect)) projected[key] += amount;
        for (const key of Object.keys(projected)) projected[key] = key === 'money' ? Math.max(0, projected[key]) : Math.max(0, Math.min(100, projected[key]));
    }
    const actual = Object.fromEntries(Object.keys(before).filter(key => Math.abs(projected[key] - before[key]) > 1e-9)
        .map(key => [key, Number((projected[key] - before[key]).toFixed(2))]));
    return { missing, complete, repay, uncompleted, fraction, energy, actual };
}
function homeworkOptionText(label, plan) {
    const lacking = Math.max(0, plan.energy - gameState.energy);
    const impact = Object.fromEntries(Object.entries(plan.actual).filter(([key]) => !Object.hasOwn(subjectNames, key)));
    return `${label} · ${plan.energy}精力${lacking ? `（还差${Number(lacking.toFixed(2))}）` : ''}\n` +
        `完成${plan.complete.length}科，补交${plan.repay.length}科次，新增欠交${plan.uncompleted.length}科次` +
        (lacking ? '\n精力不足，暂不可选。' : `\n实际变化：${Object.keys(impact).length ? previewEffect(impact) : '状态已在上下限'}`);
}
function showWeekendHomework() {
    if (!gameState.weekEnding || gameState.homeworkSettledWeek === gameState.week) return;
    const missing = Object.keys(subjectNames).filter(k => !gameState.homework[k]);
    if (!missing.length) { settleWeekendHomework('rest'); return; }
    elements.homeworkList.textContent = `${missing.map(k => subjectNames[k]).join('、')}待完成。现有精力 ${Math.floor(gameState.energy)}，旧欠交 ${gameState.homeworkBacklog.length} 科次。下方先列本次后果；未完成部分新增欠交，关闭窗口也采用留出休息的安排。`;
    const entries = [
        { label: `完成本周${missing.length}科`, mode: 'complete-all' },
        { label: `先做最弱${Math.min(2, missing.length)}科`, mode: 'complete-one' }
    ];
    const repay = Math.min(2, gameState.homeworkBacklog.length);
    if (repay) entries.push({ label: `完成本周并补交${repay}科次`, mode: 'complete-and-repay' });
    entries.push({ label: '先留出休息时间', mode: 'rest' });
    const choices = document.getElementById('weekend-choices');
    choices.innerHTML = '';
    for (const entry of entries) {
        const plan = weekendHomeworkPlan(entry.mode);
        const button = document.createElement('button');
        button.className = 'study-btn'; button.textContent = homeworkOptionText(entry.label, plan);
        button.style.whiteSpace = 'pre-line';
        button.disabled = gameState.energy < plan.energy; button.onclick = () => homework(entry.mode);
        choices.appendChild(button);
    }
    document.getElementById('homework-modal').style.display = 'flex';
    saveGame();
}
function settleWeekendHomework(action = 'rest') {
    if (!gameState.weekEnding || gameState.phase !== 'playing' || gameState.homeworkSettledWeek === gameState.week ||
        !['complete-all', 'complete-one', 'complete-and-repay', 'rest', 'skip'].includes(action)) return false;
    const { missing, complete, repay, energy } = weekendHomeworkPlan(action);
    if (gameState.energy < energy) { showNotification(`需要${energy}精力。`, 'neutral'); return false; }
    const before = metricSnapshot();
    // Mark first so closing, double clicks and restoring cannot settle twice.
    gameState.homeworkSettledWeek = gameState.week;
    applyEffect({ energy: -energy });
    for (const subject of complete) { gameState.homework[subject] = true; applyEffect({ [subject]: 0.5 }); }
    gameState.totalHomework += complete.length + repay.length;
    if (complete.length) applyEffect({ teacher: complete.length / 2, mathTeacher: complete.includes('math') ? 2 : 0,
        chineseTeacher: complete.includes('chinese') ? 2 : 0, englishTeacher: complete.includes('english') ? 2 : 0, anxiety: -complete.length / 3 });
    gameState.homeworkBacklog.splice(0, repay.length);
    for (const row of repay) applyEffect({ [row.subject]: 0.3, teacher: 1 });
    const uncompleted = missing.filter(k => !gameState.homework[k]);
    const fraction = uncompleted.length / 6;
    if (uncompleted.length) {
        for (const subject of uncompleted) gameState.homeworkBacklog.push({ week: gameState.week, subject });
        applyEffect({ teacher: -5 * fraction, mathTeacher: uncompleted.includes('math') ? -3 : 0,
            chineseTeacher: uncompleted.includes('chinese') ? -3 : 0, englishTeacher: uncompleted.includes('english') ? -3 : 0,
            energy: 8 * fraction, stress: -3 * fraction, anxiety: 2 * fraction });
    }
    const record = { week: gameState.week, kind: 'homework', detail: action, subjects: complete, completed: complete,
        missing: uncompleted, repaid: repay, weekend: true, actualEffect: actualMetricChange(before) };
    gameState.homeworkHistory.push(record); gameState.actionHistory.push(record);
    addToLog(`周末作业：完成${complete.length}科、补交${repay.length}科次、新增欠交${uncompleted.length}科次；尚欠${gameState.homeworkBacklog.length}科次。实际变化：${actualChangeText(before)}。`, uncompleted.length ? 'neutral' : 'good');
    legacy.closeModal('homework-modal');
    checkAchievements(); updateUI(); saveGame();
    continueWeekEnd();
    return true;
}
closeModal = function(id) {
    if (id === 'homework-modal' && gameState.weekEnding && gameState.homeworkSettledWeek !== gameState.week) {
        settleWeekendHomework('rest'); return;
    }
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
};
function continueWeekEnd() {
    if (gameState.activeNarrative || gameState.narrativeFeedback || gameState.narrativeQueue.length) { pumpNarrative(); return; }
    if (gameState.homeworkSettledWeek !== gameState.week) { showWeekendHomework(); return; }
    // All final-week random effects settle before S35 freezes the score.
    if (gameState.week === 52 && !gameState.weekRandomAttempted) {
        const shouldDraw = gameState.deferredRandom || Math.random() < 0.6;
        gameState.weekRandomAttempted = true;
        if (shouldDraw) { gameState.weekRandomAttempted = false; drawRandomEvent(); if (gameState.activeNarrative) return; }
    }
    const due = dueMainStories();
    if (due.length) { gameState.narrativeQueue.push(due[0].id); pumpNarrative(); return; }
    const sides = routedSideStories();
    if (sides.length) { gameState.narrativeQueue.push(sides[0].id); pumpNarrative(); return; }
    if (!gameState.weekRandomAttempted) {
        const shouldDraw = gameState.deferredRandom || Math.random() < 0.6;
        gameState.weekRandomAttempted = true;
        if (shouldDraw) { gameState.weekRandomAttempted = false; drawRandomEvent(); if (gameState.activeNarrative) return; }
    }
    applyEffect({ energy: 8, stress: -5 + Math.floor(gameState.anxiety * 0.2), health: 2, mental: 2 - Math.floor(gameState.anxiety * 0.1), anxiety: 2 });
    settleSceneDeadlines();
    gameState.wellbeingHistory.push({ week: gameState.week, health: gameState.health, mental: gameState.mental, anxiety: gameState.anxiety, stress: gameState.stress });
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
    addToLog(`新的一周，距考试还有${gameState.daysLeft}天。`, 'neutral');
    updateUI(); saveGame();
}
function checkStageGoals() {
    const next = Object.keys(stageGoals).map(Number).find(w => w >= gameState.week && !Object.hasOwn(gameState.goalResults, w));
    gameState.goalWeek = next || null;
    gameState.currentGoal = next ? stageGoals[next] : null;
    gameState.goalProgress = gameState.currentGoal ? getStageGoalStatus(gameState.currentGoal).progress : 0;
};
function getStageGoalStatus(goal, state = gameState) {
    const read = requirement => {
        const current = requirement.read(state);
        const { target, operator } = requirement;
        const passed = operator === '<' ? current < target : operator === '>' ? current > target : current >= target;
        // Round toward the same side of the boundary as the actual check.
        const shown = (operator === '>' ? Math.ceil(current * 100) : Math.floor(current * 100)) / 100;
        const fraction = operator === '<' ? (100 - current) / (100 - target) : current / target;
        return { passed, progress: passed ? 1 : Math.max(0, Math.min(0.99, fraction)),
            text: `${requirement.label}：${shown}${requirement.unit} / 要求${operator}${target}${requirement.unit}` };
    };
    const requirements = goal.requirements.map(read);
    const challenges = goal.challenges.map(read);
    const achieved = requirements.every(row => row.passed);
    const progress = achieved ? 100 : Math.min(99, Math.floor(requirements.reduce((sum, row) => sum + row.progress, 0) / requirements.length * 100));
    return { requirements, challenges, achieved, progress };
}
function renderGoalRows(rows) {
    return rows.map(row => `<li class="${row.passed ? 'goal-met' : 'goal-pending'}"><span class="goal-marker" aria-label="${row.passed ? '已满足' : '未满足'}">${row.passed ? '✓' : '○'}</span><span>${escapeText(row.text.replace(' / 要求', ' / '))}</span></li>`).join('');
}
function renderGoalSettlement(detail) {
    const missing = detail.requirements.filter(row => !row.passed);
    return `<p class="goal-note">${detail.achieved ? `主要目标达成，阶段奖励：${escapeText(detail.rewardText)}` : `未达成原因：${missing.map(row => escapeText(row.text)).join('；')}。后续阶段仍可继续。`}</p>` +
        `<ul class="goal-checklist">${renderGoalRows(detail.requirements)}</ul>` +
        (detail.challenges.length ? `<p class="goal-note">选做挑战（仅记录，不影响阶段奖励）</p><ul class="goal-checklist">${renderGoalRows(detail.challenges)}</ul>` : '') +
        (Array.isArray(detail.mementos) ? detail.mementos.filter(t => typeof t === 'string').map(t => `<p class="narrative-note">${escapeText(t)}</p>`).join('') : '');
}
function claimStageGoal() {
    if (gameState.phase !== 'playing' || !gameState.goalWeek || gameState.finalSnapshot) return;
    const week = gameState.goalWeek, goal = stageGoals[week];
    if (Object.hasOwn(gameState.goalResults, week) || gameState.goalClaims[week]) return;
    const status = getStageGoalStatus(goal);
    if (!status.achieved) return;
    const read = key => Object.hasOwn(relationshipNames,key) ? gameState.relationships[key] : gameState[key];
    const before = Object.fromEntries(Object.keys(goal.reward).map(k => [k, read(k)]));
    applyEffect(goal.reward);
    const actual = Object.fromEntries(Object.keys(goal.reward).map(k => [k, Math.round((read(k)-before[k])*100)/100]));
    if (Object.values(actual).every(v => v === 0)) { applyEffect({ money: 20 }); actual.money = 20; }
    gameState.goalClaims[week] = { week: gameState.week, requirements: status.requirements.map(({text,passed}) => ({text,passed})), actualReward: previewEffect(actual) };
    addToLog(`${goal.title}已达成，奖励已领取：${previewEffect(actual)}。`, 'good');
    showNotification(`目标达成 · ${previewEffect(actual)}`, 'good');
    saveGame();
}
function settleStageGoal() {
    if (gameState.goalWeek !== gameState.week || Object.hasOwn(gameState.goalResults, gameState.week)) return;
    const goal = stageGoals[gameState.week];
    const status = getStageGoalStatus(goal);
    claimStageGoal();
    const claim = gameState.goalClaims[gameState.week];
    const achieved = !!claim;
    gameState.goalResults[gameState.week] = achieved;
    const detail = { week: gameState.week, title: goal.title, achieved,
        requirements: claim ? claim.requirements : status.requirements.map(({ text, passed }) => ({ text, passed })),
        challenges: status.challenges.map(({ text, passed }) => ({ text, passed })), rewardText: claim?.actualReward || previewEffect(goal.reward), mementos: [] };
    if (gameState.week === 25 && status.challenges[1]?.passed) detail.mementos.push('蓝本便签：你把确实发生过的交流题名写在同一页，采访、小群里的问题和愿意分享的生活都有各自的位置。熟悉不等于喜欢，这些交谈本身已经留下过声音。');
    if (gameState.week === 45 && status.challenges[0]?.passed) detail.mementos.push('蓝本便签：两位已经熟悉的人的名字留在页边。你知道可以怎样问候他们，也知道熟悉不会替任何人保证此后的关系。');
    gameState.goalDetails[gameState.week] = detail;
    const reason = achieved ? `主要目标达成，阶段奖励：${detail.rewardText}` :
        `主要目标未达成；未满足：${detail.requirements.filter(row => !row.passed).map(row => row.text).join('；')}。后面的安排仍可继续`;
    const extra = detail.challenges.length ? `\n选做挑战（仅记录）：${detail.challenges.map(row => `${row.passed ? '已满足' : '未满足'} ${row.text}`).join('；')}` : '';
    addToLog(`${goal.title}：${reason}。${extra}`, achieved ? 'good' : 'neutral');
}
function updateGoalText() {
    const goal = gameState.currentGoal;
    const status = goal ? getStageGoalStatus(goal) : null;
    const claim = gameState.goalClaims[gameState.goalWeek];
    elements.currentGoal.textContent = goal ? goal.title : '本轮阶段目标已结算';
    document.getElementById('goal-reward').textContent = goal ? claim ? `✓ 奖励已领取：${claim.actualReward}` : `达标即领：${previewEffect(goal.reward)}` : '六个阶段已结算';
    document.getElementById('goal-reward').title = '原奖励全部因满值无法生效时，转为20元资料补贴。';
    gameState.goalProgress = claim ? 100 : status?.progress || 0;
    elements.goalProgress.style.width = `${gameState.goalProgress}%`;
    elements.goalProgress.setAttribute('aria-valuenow', gameState.goalProgress);
    document.getElementById('goal-progress-status').textContent = status ?
        claim ? `目标已达成；以下为第${claim.week}周领取时记录，选做挑战在截止周记录。` : `${status.requirements.filter(row => row.passed).length}/${status.requirements.length} 项满足 · 截止周前达标即可领取。` : '剩余周数可自由安排。';
    if (claim) document.getElementById('goal-reward').textContent += ` · 第${claim.week}周领取时`;
    document.getElementById('goal-requirements').innerHTML = claim ? renderGoalRows(claim.requirements) : status ? renderGoalRows(status.requirements) : '';
    const extra = document.getElementById('goal-challenges');
    extra.style.display = status?.challenges.length ? 'block' : 'none';
    extra.innerHTML = status?.challenges.length ? `<details><summary>选做挑战</summary><ul class="goal-checklist">${renderGoalRows(status.challenges)}</ul></details>` : '';
    const lastWeek = Object.keys(gameState.goalResults).map(Number).filter(w => w <= gameState.completedWeeks && Object.hasOwn(stageGoals, w)).sort((a, b) => b - a)[0];
    const last = document.getElementById('goal-latest-result');
    last.style.display = lastWeek ? 'block' : 'none';
    if (lastWeek) {
        const detail = gameState.goalDetails[lastWeek];
        document.getElementById('goal-latest-summary').textContent = `${stageGoals[lastWeek].title} · ${gameState.goalResults[lastWeek] ? '已达成' : '未达成'}${detail ? '' : '（旧版记录）'}`;
        document.getElementById('goal-latest-detail').innerHTML = detail ? renderGoalSettlement(detail) : '<p class="goal-note">旧存档没有分项结算记录，保留原达成结果；不会按新条件补算奖励。</p>';
    }
};
changeWeather = function() {
    gameState.previousWeather = gameState.currentWeather?.id || null;
    legacy.changeWeather();
    const ids = { '晴天': 'sun', '阴天': 'cloud', '雨天': 'rain', '雷雨': 'thunder', '雾霾': 'fog' };
    gameState.currentWeather = { ...gameState.currentWeather, id: ids[gameState.currentWeather.name] };
};
checkHolidays = function() {
    const before = metricSnapshot();
    legacy.checkHolidays();
    const holiday = Object.values(holidays).find(value => value.week === gameState.week);
    if (holiday) addToLog(`${holiday.name}（${holiday.days}天）按周内的一段安排记录，每周仍为3次行动；本次即时调适：${actualChangeText(before)}。`, 'neutral');
};
function checkSpecialDay() { /* The calendar is an abstract 52-week year. */ };
function unlockAchievement(id) {
    if (!Object.hasOwn(achievements, id) || gameState.achievements.has(id)) return;
    gameState.achievements.add(id);
    const recent = id.startsWith('hidden-') ? gameState.events.filter(value => /^H/.test(value)).at(-1) : null;
    showNotification(`成就：${achievements[id].name} · ${achievements[id].desc}${recent ? `（刚读到“${findNarrative(recent).title}”）` : ''}`, 'good');
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
function sceneChoice(id, state = gameState) {
    return (state.storyChoices[id] || state.sceneChoices?.[id])?.key;
}
function chose(id, key, state = gameState) { return sceneChoice(id, state) === key; }
function sceneRequirementsMet(node, state = gameState) {
    return (node.requires || []).every(r => state.events.includes(r.id) && (!r.keys.length || r.keys.includes(sceneChoice(r.id, state))));
}
function peerInteractionCount(state = gameState) {
    const scenes = ['S05', 'S16', 'S17', 'H05', 'H07', 'H08', 'H09'].filter(id =>
        id === 'S05' ? chose(id, 'B', state) : id === 'S16' ? ['A', 'B'].includes(sceneChoice(id, state)) : !!sceneChoice(id, state)).length;
    return scenes + (state.actionHistory || []).filter(a => a.kind === 'social' && a.detail === 'crush' || a.kind === 'studyGroup' && a.partner === 'crush').length;
}
function hasRomanceEvent(type, state = gameState) { return state.romanceHistory?.some(e => e.type === type) || false; }
function recordRomanceOutcome(node, c) {
    if (!['S24', 'H08', 'S33'].includes(node.id)) return;
    const record = type => {
        if (!gameState.romanceHistory.some(e => e.scene === node.id && e.type === type))
            gameState.romanceHistory.push({ scene: node.id, type, week: gameState.week });
    };
    if (node.id === 'S24') gameState.romance = { A: '慢慢了解', B: '朋友', C: '暂不命名' }[c.key];
    if (node.id === 'H08') {
        if (c.key === 'A' && chose('S24', 'A')) {
            if (chose('H07', 'A')) { record('rejected'); gameState.romance = '告白被拒绝'; }
            else { record('mutual'); gameState.romance = '明确互相喜欢'; }
        } else if (c.key === 'C') gameState.romance = '朋友';
    }
    if (node.id === 'S33') {
        if (hasRomanceEvent('rejected')) gameState.romance = c.key === 'B' ? '被拒后朋友' : '告白被拒绝';
        else if (hasRomanceEvent('mutual') && chose('H09', 'A')) { record('ended'); gameState.romance = '已结束'; }
        else if (c.key === 'A') {
            if (chose('H07', 'A') && chose('H08', 'A')) { record('rejected'); gameState.romance = '告白被拒绝'; }
            else if (chose('H07', 'B') && chose('H08', 'A') && chose('H09', 'B')) { record('mutual'); gameState.romance = '明确互相喜欢'; }
            else gameState.romance = hasRomanceEvent('mutual') ? '明确互相喜欢' : '慢慢了解';
        } else gameState.romance = c.key === 'B' ? '朋友' : '暂不命名';
    }
    gameState.mutualAffirmation = gameState.romance === '明确互相喜欢' && hasRomanceEvent('mutual');
}
function restoreNarrativeEvidence() {
    const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    gameState.sceneChoices = Object.fromEntries(Object.entries(object(gameState.sceneChoices)).filter(([id, r]) => {
        const n = findNarrative(id);
        return n?.kind === 'side' && gameState.events.includes(id) && n.choices.some(c => c.key === r?.key) && Number.isInteger(r.week) && r.week >= n.week && r.week <= n.until;
    }));
    gameState.missedScenes = Object.fromEntries(Object.entries(object(gameState.missedScenes)).filter(([id, week]) => {
        const n = findNarrative(id);
        return n?.revision && week === n.until && !gameState.events.includes(id) && sceneRequirementsMet(n);
    }));
    gameState.romanceHistory = Array.isArray(gameState.romanceHistory) ? gameState.romanceHistory.filter(e =>
        e && ['H08', 'S33'].includes(e.scene) && ['mutual', 'rejected', 'ended'].includes(e.type) &&
        gameState.events.includes(e.scene) && Number.isInteger(e.week)) : [];
    const history = Array.isArray(gameState.wellbeingHistory) ? gameState.wellbeingHistory : [];
    const seen = new Set();
    gameState.wellbeingHistory = history.filter(row => row && Number.isInteger(row.week) && row.week >= 1 && row.week <= gameState.completedWeeks &&
        !seen.has(row.week) && ['health', 'mental', 'anxiety', 'stress'].every(k => Number.isFinite(row[k]) && row[k] >= 0 && row[k] <= 100) && !!seen.add(row.week));
    gameState.routePlans = object(gameState.routePlans);
    for (const [route, plan] of Object.entries(gameState.routePlans)) {
        if (!validRoutePlan(route, plan)) delete gameState.routePlans[route];
    }
    // Count actual completed main nodes; a missing node never becomes a cosmetic 36/36.
    gameState.storyProgress = narrativeData.stories.filter(n => n.kind === 'main' && gameState.events.includes(n.id)).length;
}
function settleSceneDeadlines() {
    for (const node of narrativeData.stories.filter(n => n.kind === 'side' && n.revision && n.missedFeedback)) {
        const id = node.id;
        if (node.until !== gameState.week || gameState.events.includes(id) || !sceneRequirementsMet(node) || gameState.missedScenes[id]) continue;
        gameState.missedScenes[id] = gameState.week;
        addToLog(`“${node.title}”的期限已过。${node.missedFeedback}`, 'story');
    }
}
function persistentDifficulty(state = gameState, physical = false) {
    const after = (state.sceneChoices?.H26?.week || 35);
    const bad = row => physical ? row.health < 45 : row.mental < 45 || row.anxiety >= 65 || row.stress >= 75;
    return !!state.finalSnapshot && bad(state.finalSnapshot) && (state.wellbeingHistory || []).filter(row => row.week >= after && bad(row)).length >= 3;
}
function lineResults(state = gameState) {
    const c = (id, key) => chose(id, key, state);
    const missed = id => !!state.missedScenes?.[id];
    return {
        recording: c('H29', 'A') && (!!sceneChoice('H30', state) || missed('H30')),
        circle: c('H31', 'A') && (!!sceneChoice('H32', state) || missed('H32')),
        venue: c('H33', 'A') && (!!sceneChoice('H34', state) || missed('H34')),
        desk: c('H10', 'A') && (c('H11', 'B') || c('H11', 'C') || missed('H11')),
        team: !!sceneChoice('H12', state) && (c('H13', 'A') || c('H13', 'B') || missed('H13')),
        family: c('H14', 'A') && (!!sceneChoice('H15', state) || missed('H15')),
        teacher: c('H16', 'B') && (c('H17', 'B') || missed('H17')) || c('H16', 'A') && (c('H17', 'A') || c('H17', 'B') || missed('H17')),
        mathTeacher: c('H18', 'A') && (c('H19', 'A') || c('H19', 'B') || missed('H19')),
        chineseTeacher: c('H20', 'A') && (c('H21', 'A') || c('H21', 'B') || missed('H21')),
        englishTeacher: c('H22', 'A') && (c('H23', 'A') || c('H23', 'B') || missed('H23')),
        oi: c('H24', 'A') && (c('H25', 'A') || c('H25', 'C') || missed('H25')),
        body: c('H26', 'A') && persistentDifficulty(state, true),
        mind: c('H26', 'A') && persistentDifficulty(state),
        crushReject: hasRomanceEvent('rejected', state),
        crushBreakup: hasRomanceEvent('ended', state)
    };
}
function chooseEpilogues(state = gameState) {
    const index = id => ({ A: '01', B: '02', C: '03' }[state.storyChoices[id]?.key] || '04');
    const final = state.finalSnapshot;
    let health = 'ST04';
    if (final && ['health', 'mental', 'anxiety', 'stress'].every(k => Number.isFinite(final[k]))) {
        health = final.health < 45 ? 'ST01' : final.anxiety >= 65 || final.stress >= 75 || final.mental < 45 ? 'ST02' :
            final.health >= 75 && final.mental >= 65 && final.anxiety < 40 && final.stress < 50 ? 'ST03' : 'ST04';
    }
    const lines = lineResults(state);
    if (lines.body || lines.mind) health = lines.body ? 'BODY_BE' : 'MIND_BE';
    const peer = lines.crushBreakup ? 'PEER_END' : lines.crushReject ? state.romance === '被拒后朋友' ? 'PEER_REJECT_FRIEND' : 'PEER_REJECT' :
        state.romance === '朋友' ? 'PEER01' : state.romance === '慢慢了解' ? 'PEER02' : state.romance === '明确互相喜欢' && state.mutualAffirmation ? 'PEER03' : 'PEER04';
    const selected = [lines.family ? 'FAMILY_BE' : 'F' + index('S34'), lines.desk ? 'DESK_BE' : 'DESK' + index('S28'),
        lines.team ? 'TEAM_BE' : 'TEAM' + index('S14'), peer, health, lines.oi ? 'OI_BE' : 'OI' + index('S30')];
    for (const [line, setup, result, goodKey, prefix] of [['teacher', 'H16', 'H17', 'C', 'TEACHER'], ['mathTeacher', 'H18', 'H19', 'C', 'MATH'],
        ['chineseTeacher', 'H20', 'H21', 'C', 'CHINESE'], ['englishTeacher', 'H22', 'H23', 'C', 'ENGLISH']]) {
        if (lines[line]) selected.push(prefix + '_BE');
        else if (sceneChoice(setup, state) && (chose(result, goodKey, state) || line === 'teacher' && chose(result, 'A', state))) selected.push(prefix + '_OK');
    }
    const routeBE = routeRegret(state.finalRoute, state);
    if (lines.recording) selected.push('VOICE_BE');
    if (lines.circle) selected.push('CIRCLE_BE');
    if (lines.venue) selected.push('VENUE_BE');
    if (routeBE) selected.push(routeBE);
    return selected;
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
const routePlanOptions = {
    C01: { project: ['lanchuan', 'beichen'], materials: ['complete', 'general'] },
    C02: { mode: ['dorm', 'local'] }, C03: { wish: ['exhibit', 'daily'] }, C04: { mode: ['rota', 'compare'] }
};
function validRoutePlan(route, plan) {
    return !!routePlanOptions[route] && plan && typeof plan === 'object' && !Array.isArray(plan) &&
        Object.entries(plan).every(([field, value]) => routePlanOptions[route][field]?.includes(value));
}
function routePlanReady(route) {
    const plan = gameState.routePlans[route];
    return validRoutePlan(route, plan) && Object.keys(routePlanOptions[route]).every(field => plan[field]);
}
function setRoutePlan(route, field, value) {
    if (gameState.phase !== 'postExam' || gameState.finalRoute || !routePlanOptions[route]?.[field]?.includes(value)) return false;
    const plan = { ...gameState.routePlans[route], [field]: value };
    if (!validRoutePlan(route, plan)) return false;
    gameState.routePlans[route] = plan;
    saveGame(); renderPostExam(route);
    return true;
}
function applicationResults(state = gameState) {
    const plan = state.routePlans?.C01;
    if (!plan?.project || !plan.materials || !state.finalSnapshot) return null;
    const score = state.finalSnapshot.score;
    const lanchuan = score >= 90, beichen = score >= 95 && plan.materials === 'complete';
    const preferred = plan.project === 'beichen' ? '北辰大学计算系统研修项目' : '岚川大学计算与生活基础项目';
    return { rejected: plan.project === 'beichen' ? !beichen : !lanchuan,
        text: `你实际将两项申请一起递交，明确更希望去${preferred}。岚川项目${lanchuan ? '发来录取答复' : '没有通过，冻结的成绩未达到参考指数90'}；北辰项目${beichen ? '发来录取答复' : score < 95 ? '拒绝申请，本次成绩未达到参考指数95' : '拒绝申请，缺少已说明的完整研修说明'}。${plan.project === 'beichen' && !beichen || plan.project === 'lanchuan' && !lanchuan ? '你明确期待的项目没有通过。另一项结果和之后的安排都没有抹去这次失败。' : '你确认了更想去的项目，也保留另一封实际答复。'}` };
}
function routeRegret(route, state = gameState) {
    const plan = state.routePlans?.[route];
    if (!plan) return null;
    if (route === 'C01' && applicationResults(state)?.rejected) return 'ROUTE_C01_BE';
    if (route === 'C02' && plan.mode === 'dorm') return 'ROUTE_C02_BE';
    if (route === 'C03' && plan.wish === 'exhibit' && (persistentDifficulty(state, true) || persistentDifficulty(state))) return 'ROUTE_C03_BE';
    if (route === 'C04' && plan.mode === 'rota') return 'ROUTE_C04_BE';
    return null;
}
function routePreparation(route) {
    const plan = gameState.routePlans[route] || {};
    const button = (field, value, label) => `<button class="restart-btn plan-choice" aria-pressed="${plan[field] === value}" onclick="setRoutePlan('${route}','${field}','${value}')">${plan[field] === value ? '✓ ' : ''}${escapeText(label)}</button>`;
    if (route === 'C01') return `<section class="route-plan"><h3>两项实际申请</h3><p>岚川：基础课程宽、可走读，参考指数90。北辰：系统实验、小班与住宿，参考指数95且须完整研修说明。两项一并递交；先选更期待哪项，再决定材料。答复依据本次已确定成绩和这里留下的材料记录。</p>${chose('H28', 'A') ? '<p>你在筹备时圈过北辰的系统实验。现在可以重新确认偏好。</p>' : ''}${button('project', 'lanchuan', '更期待岚川的课程与走读')}${button('project', 'beichen', '更期待北辰的系统研修')}<p>研修说明和共同材料</p>${button('materials', 'complete', '核对完整研修说明后递交')}${button('materials', 'general', '按目前只有通用说明的材料递交')}</section>`;
    if (route === 'C02') return `<section class="route-plan"><h3>想赶上哪一种开班方式</h3><p>岚桥第一期宿舍施工仍未确认。你可以继续争取这一期住宿，也可以从本地走读方案开始核实。认真询问无法保证宿舍按期开放。</p>${button('mode', 'dorm', '仍想住第一期宿舍，继续询问延期入住')}${button('mode', 'local', '先核对本地走读，不把未确认宿舍当作已有条件')}</section>`;
    if (route === 'C03') return `<section class="route-plan"><h3>休整时具体盼望什么</h3><p>城市展览在七月第一个周末闭幕。你可以把按期出门作为愿望，也可以暂时只照顾日常。后记会结合实际持续状态，不会把选择休整本身判成失败。</p>${button('wish', 'exhibit', '希望休整后赶在闭幕前去看展览')}${button('wish', 'daily', '暂不设有期限的活动，先安排日常照护')}</section>`;
    return `<section class="route-plan"><h3>岗位与课程能否同时落实</h3><p>设备整理岗位需要轮班，石桥晚间课程的时段固定。你仍希望兼顾两者，调班却还没有获准。除了是否申请，也要先想清若不能调整，愿意怎样取舍。</p>${button('mode', 'rota', '先申请调班；若不成，接受岗位、放下本期课程')}${button('mode', 'compare', '暂不接受冲突排班，继续比较其他岗位')}${plan.mode === 'rota' ? '<p class="goal-note" role="status">你选择先争取调班。如果岗位和课程的时间最终都不能调整，就接受岗位，放下这一期晚间课程。确认这个方向会一并确认这项取舍，之后再得到实际答复。</p>' : plan.mode === 'compare' ? '<p class="goal-note" role="status">你暂不接受这一份排班；确认后继续了解和比较，住处、收入与其他岗位仍未落实。</p>' : ''}</section>`;
}
function epilogueContent(key, state = gameState) {
    const friendDetail = peerInteractionCount(state) >= 4 ? '一起改过的稿、听过的录音给你们留了具体话题。后来偶尔约时间分享新稿，也仍会先问对方是否有空。' : '你们共同经历还不多，毕业后偶尔互道近况，没有变成每天分享生活的亲密朋友。';
    const text = narrativeData.endings[key].content;
    return text.replace('{friendDetail}', friendDetail)
        .replace('{venueAttempt}', chose('H34', 'A', state) ? '最后一次你核对答复，扶着梯子看店主把店名卸下来。意见被收下，续租仍未获准，他也决定不再经营。' : chose('H34', 'B', state) ? '你帮店主封好最后一箱书，看着他签下交还钥匙的单子。关店没有被写成暂时分别，也没有留下重开的日期。' : '店主发来交还钥匙的消息。书已搬空，店名已经取下；你整理过的读者意见没有换来续租，他也不另开店。')
        .replace('{circleAttempt}', chose('H32', 'A', state) ? '你问过更短、更少、只连声音的办法，也逐一听过最后的答复。大家不再维持这份共同安排，空出的月份没有补上。' : chose('H32', 'B', state) ? '你们把不再继续这份共同安排说清，划掉了未来的月份。你收好日历，留下的只有试坐那一晚。' : '最后一轮核对结束，三个人都确认不再维持这份四人安排。你没有再得到一个能聚齐的日期。')
        .replace('{recordingAttempt}', chose('H30', 'A', state) ? '你又带着原盘核对了一次，得到相同的结论。两份报告都没有可用音频，认真再试一次也没能留下那句原声。' : chose('H30', 'B', state) ? '你读完报告，停止继续恢复。那句想保留的话没有找回来，你没有拿后来的重录冒充它。' : '老师转来最终报告时，恢复窗口已经结束。你想保留的那一句没有找回来，报告只确认了损坏和没有备份。')
        .replace('{teamOrigin}', chose('H12', 'B', state) ? '你把旧队友的遗憾说成没想开，他收回了一次邀请。' : '你曾认真听过旧队友的遗憾，也希望继续亲近，他却决定把下一段生活和旧队伍分开。')
        .replace('{teamAttempt}', chose('H13', 'A', state) ? '你认真提出重新聊，他听完仍不想回到以前的亲密。' : '后来没有恢复原先的单独约见。')
        .replace('{familyAttempt}', chose('H15', 'B', state) ? '班主任帮你们谈过一次，决定仍没改变。' : chose('H15', 'A', state) ? '你把准备完整讲过，最终的答复仍是否定。' : '期限过去，这项支持仍没有落实。')
        .replace('{teacherAttempt}', chose('H16', 'A', state) ? '你按约到场，老师给过一般材料建议，但期待的系统方向专门咨询最终取消了；后面也没有补开的名额。' : chose('H17', 'B', state) ? '最后一次你只交出成绩单，没能谈清方向。' : '你没有在已经说明的期限内完成预约。')
        .replace('{oiAttempt}', chose('H25', 'C', state) ? '你到了门口，仍无法打开旧题，提前离开。' : chose('H25', 'A', state) ? '你按通知赶到，临时提前的搬迁却已封起机房。教练也尝试申请延后，没有获准。' : '你想参加，却错过了当天的联系与到场窗口。')
        .replace('{oiArchive}', chose('S30', 'A', state) ? '后来你把旧稿带回家，纸箱里还夹着那张日期已经过去的展示通知。' : chose('S30', 'B', state) ? '你把大部分旧稿归好，只留一页在蓝本里。' : chose('S30', 'C', state) ? '你把纸箱交给老师保管，记下以后领取的办法。那张展示通知上的日期已经过去。' : '那张写过日期的展示通知仍留在蓝本里。')
        .replace('{applicationResult}', applicationResults(state)?.text || '旧记录里没有具体申请材料，不能据此补写一次失败。');
}
function mainEndingContent(id) {
    const application = gameState.finalRoute === 'C01' ? applicationResults() : null;
    if (application) {
        const acceptedPreferred = !application.rejected;
        return application.text + '\n\n' + (acceptedPreferred ? '你把课程、交通和住处重新排进蓝本。录取已经确认，曾经盼望而没有发生的其他事也还在这一年的记录里。' : '你把拒信和本次成绩一起夹进蓝本。眼前要处理的安排仍然具体，想去的那一处却没有成为这一次的去向。');
    }
    if (routeRegret(gameState.finalRoute)) return '你确认了这个方向，也带着之前留下的具体期待继续核实。接下来的答复已经写在去向后记里，本次成绩保持原样。';
    return narrativeData.endings[id].content;
}
function prepareFinalLayout() {
    document.querySelector('.container').classList.add('post-exam');
    updateNarrativeStatus();
}
function finalRecord() {
    const f = gameState.finalSnapshot;
    return `<div class="final-score">${f.score}/100</div><p>本次成绩指数 · 游戏中的成长记录</p><p>${Object.entries(f.subjects).map(([k, v]) => `${subjectNames[k]} ${v.toFixed(1)}`).join(' · ')}</p>`;
}
function postExamStoryComplete() {
    return gameState.events.includes('S36') && !gameState.activeNarrative &&
        !gameState.narrativeFeedback && gameState.narrativeQueue.length === 0;
}
function routeDescription(entry) {
    return `${paragraphs(entry.content)}<h4>需要准备的事</h4><ul>${entry.preparation.map(item => `<li>${escapeText(item)}</li>`).join('')}</ul><h4>需要考虑的代价</h4>${paragraphs(entry.cost)}<h4>确认前再看一遍</h4>${paragraphs(entry.confirmation)}`;
}
function renderPostExam(route = null) {
    if (!gameState.finalSnapshot) return;
    prepareFinalLayout();
    if (gameState.finalRoute) { renderEnding(); return; }
    const main = document.querySelector('.main');
    const entry = routePlanOptions[route] ? narrativeData.endings[route] : null;
    const storyComplete = postExamStoryComplete();
    main.innerHTML = `<div class="end-screen"><h2>铃响以后</h2>${finalRecord()}${!storyComplete ? '<p class="goal-note" role="status">考后剧情尚未读完。可以先查看和填写准备事项；请继续读完剧情及选择反馈，再确认去向。</p>' : ''}${entry ? `<h3>${escapeText(entry.title)}</h3><div class="ending-text route-description">${routeDescription(entry)}</div>${routePreparation(route)}<div class="route-confirm"><button class="restart-btn" ${routePlanReady(route) && storyComplete ? '' : 'disabled'} onclick="confirmRoute('${route}')">确认这个方向</button><button class="restart-btn" onclick="renderPostExam()">返回四项选择</button></div>` :
        `<p>先查看准备事项、代价与需要核实的支持，确认前可以自由返回。四项对所有成绩开放。</p>${['C01', 'C02', 'C03', 'C04'].map(id => `<button class="restart-btn" onclick="renderPostExam('${id}')">${escapeText(narrativeData.endings[id].title)}</button>`).join('')}`}
        ${!storyComplete ? '<button class="restart-btn" onclick="pumpNarrative()">继续考后剧情</button>' : ''}
        <p class="narrative-note">进度自动保存，可以稍后继续决定。</p></div>`;
}
function confirmRoute(route) {
    if (!routePlanOptions[route] || gameState.phase !== 'postExam' || !gameState.finalSnapshot) return false;
    if (!postExamStoryComplete()) {
        showNotification('请先继续读完考后剧情和选择反馈，再确认去向。', 'neutral');
        pumpNarrative();
        return false;
    }
    const id = mainEndingId(route, gameState.finalSnapshot.score);
    gameState.finalRoute = route; gameState.phase = 'ending';
    unlockAchievement('ending-' + id);
    saveGame(); renderEnding();
    return true;
}
function renderEnding() {
    prepareFinalLayout();
    const id = mainEndingId(gameState.finalRoute, gameState.finalSnapshot.score);
    const ending = narrativeData.endings[id];
    const epilogues = chooseEpilogues();
    const application = gameState.finalRoute === 'C01' ? applicationResults() : null;
    const routeBE = routeRegret(gameState.finalRoute);
    const title = application ? application.rejected ? '两封回信，与没有成行的愿望' : gameState.routePlans.C01.project === 'beichen' ? '北辰的系统实验' : '岚川的课程表' : routeBE ? narrativeData.endings[routeBE].title : ending.title;
    const beCount = epilogues.filter(key => narrativeData.endings[key].be).length;
    document.querySelector('.main').innerHTML = `<div class="end-screen"><h2>${escapeText(title)}</h2>${finalRecord()}<div class="ending-text">${paragraphs(mainEndingContent(id))}${epilogues.map(key => `<details class="epilogue" open><summary>${escapeText(narrativeData.endings[key].title)}${narrativeData.endings[key].be ? ' · 遗憾' : ''}</summary>${paragraphs(epilogueContent(key))}</details>`).join('')}</div><p>${beCount ? `这一年留下${beCount}份没有实现的期待。它们各有来处，也各自留在这里。` : '这一年的选择与实际经历已留在这里。'}这份成绩与本次选择已保存。学校和项目均为虚构。</p></div>`;
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
            updateUI();
            document.querySelector('.actions').style.display = 'none';
            document.getElementById('actionCounter').style.display = 'none';
            document.getElementById('welcome-modal').style.display = 'none';
            renderPostExam(); pumpNarrative(); return;
        }
        document.getElementById('welcome-modal').style.display = 'none';
    }
    updateUI();
    if (restored) { showNotification(`已继续第${gameState.week}周存档，原进度已保留。`, 'neutral'); pumpNarrative(); }
};
window.onload = initGame;
