"""Compile the three Chinese content manuscripts into offline browser data.

Run: python scripts/build-narrative.py
No runtime Python or network dependency. Unknown effects fail the build.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUBJECTS = dict(zip(('语文', '数学', '英语', '物理', '化学', '生物'),
                    ('chinese', 'math', 'english', 'physics', 'chemistry', 'biology')))
FIELDS = {**SUBJECTS, '精力': 'energy', '压力': 'stress', '健康': 'health',
          '心理': 'mental', '焦虑': 'anxiety', '金钱': 'money', '父母关系': 'parents',
          '语文老师关系': 'chineseTeacher', '英语老师关系': 'englishTeacher'}
ROLES = {'001': '班主任', '002': '数学', '003': '语文', '004': '英语',
         '005': '同桌', '006': '旧队友', '007': '校园记录同学', '008': '原教练'}
RELATIONS = {'001': 'teacher', '002': 'mathTeacher', '003': 'chineseTeacher',
             '004': 'englishTeacher', '005': 'classmateA', '006': 'classmateB', '007': 'crush'}


def clean(text):
    text = text.replace('\\\n', '\n')
    text = re.sub(r'【人物姓名_(\d{3})】', lambda m: ROLES[m[1]], text)
    return text.replace('**', '').strip()


def effects(text):
    result = {}
    consumed = set()
    # Multiple people may share one relation delta.
    for match in re.finditer(r'((?:【人物姓名_\d{3}】(?:老师)?[、，]?)+)关系(?:各)?\s*([+-]\d+(?:\.\d+)?)', text):
        consumed.add(match.start(2))
        for ident in re.findall(r'人物姓名_(\d{3})', match[1]):
            if ident not in RELATIONS:
                raise ValueError('Undefined relationship: ' + ident)
            result[RELATIONS[ident]] = float(match[2])
    for name, field in FIELDS.items():
        match = re.search(re.escape(name) + r'\s*([+-]\d+(?:\.\d+)?)', text)
        if match:
            result[field] = float(match[1])
            consumed.add(match.start(1))
    for match in re.finditer(r'((?:语文|数学|英语|物理|化学|生物)(?:、(?:语文|数学|英语|物理|化学|生物))+)各\s*([+-]\d+(?:\.\d+)?)', text):
        consumed.add(match.start(2))
        for name in match[1].split('、'):
            result[SUBJECTS[name]] = float(match[2])
    if '两位老师关系各 +1' in text:
        result.update(chineseTeacher=1, englishTeacher=1)
        consumed.add(text.index('+1', text.index('两位老师关系各')))
    if re.search(r'六科各\s*\+0\.2', text):
        result['subjects'] = {'all': 0.2}
        consumed.add(re.search(r'六科各\s*(\+0\.2)', text).start(1))
    for match in re.finditer(r'(?:选一科|所选一科|所选最薄弱科|所选最弱科|所选弱科|两门不同科目[，、]?\s*各|两门不同弱科各)\s*(\+1\.2|\+0\.6)', text):
        consumed.add(match.start(1))
    for match in re.finditer(r'(?:该错题所属学科|你们讨论的已选学科|本次主动学习科目)\s*(\+0\.[57])', text):
        consumed.add(match.start(1))
    for match in re.finditer(r'[+-]\d+(?:\.\d+)?', text):
        if match.start() not in consumed:
            raise ValueError('Unrecognized effect; add an explicit supported field: ' + text)
    return result


def sections(text, pattern):
    matches = list(re.finditer(pattern, text, re.M))
    return [(m, text[m.end():matches[i+1].start() if i+1 < len(matches) else len(text)])
            for i, m in enumerate(matches)]


def stories():
    text = (ROOT / '剧情.md').read_text(encoding='utf-8-sig')
    output = []
    for m, block in sections(text, r'^### ([SHM]\d{2})｜([^\n]+)'):
        block = re.split(r'^## ', block, maxsplit=1, flags=re.M)[0]
        ident, heading = m[1], m[2]
        headparts = heading.split('｜')
        title = headparts[-1].replace('（学习节点）', '')
        weeknums = re.findall(r'\d+', headparts[0]) if ident[0] != 'M' else []
        choices = list(re.finditer(r'^- \*\*([ABC])．(.+?)\*\*', block, re.M))
        if not choices:
            raise ValueError('No story choices: ' + ident)
        intro = block[:choices[0].start()]
        entry = re.search(r'\*\*入口：\*\*([^\n]+)', intro)
        if entry:
            intro = intro[entry.end():]
        node = {'id': ident, 'kind': {'S': 'main', 'H': 'side', 'M': 'memory'}[ident[0]],
                'title': clean(title), 'content': clean(intro), 'choices': []}
        if weeknums:
            node['week'] = int(weeknums[0])
            node['until'] = int(weeknums[-1])
        for i, choice in enumerate(choices):
            body = block[choice.end():choices[i+1].start() if i+1 < len(choices) else len(block)]
            body = re.split(r'\*\*(?:后续|结算顺序)', body, maxsplit=1)[0]
            e = re.search(r'建议(?:差异效果)?[：:]\s*([^\n]+)', body)
            feedback = body[:e.start()] if e else body
            suggestion = e[1] if e else ''
            item = {'key': choice[1], 'text': clean(choice[2]), 'feedback': clean(feedback),
                    'effect': effects(suggestion)}
            if '所选' in suggestion or '两门不同' in suggestion or '选一科' in suggestion:
                item['target'] = 'pair' if '两门' in suggestion else 'any'
                if ident == 'S07':
                    item['target'] = 'weak' if choice[1] == 'A' else 'strong'
                if ident == 'S29' or ident == 'S32' and choice[1] == 'B':
                    item['target'] = 'weak'
                if ident == 'H06':
                    item['target'] = 'weakBelow40' if choice[1] == 'A' else 'oneOrPairBelow40'
            node['choices'].append(item)
        if ident[0] == 'S' and ident != 'S36':
            node['commonEffect'] = {'subjects': {'all': 0.2}}
        if ident[0] == 'M':
            node['cost'] = {'energy': -10, 'anxiety': -2}
        output.append(node)
    assert [n['id'] for n in output if n['kind'] == 'main'] == [f'S{i:02}' for i in range(1, 37)]
    assert len(output) == 46
    return output


def random_events():
    text = (ROOT / '随机事件.md').read_text(encoding='utf-8-sig')
    output = []
    for m, block in sections(text, r'^### (RAND-[LRBMEX]\d{2})｜([^\n]+)'):
        lines = block.splitlines()
        condition = next(x.split('：', 1)[1] for x in lines if x.startswith('- 适用条件：')).rstrip('。')
        body = next(x.split('：', 1)[1] for x in lines if x.startswith('- 正文：'))
        effect_lines = [x for x in lines if x.startswith('- 效果建议：') or x.startswith('- 选项 ')]
        line = '；'.join(effect_lines)
        event = {'id': m[1], 'kind': 'random', 'category': m[1][5],
                 'title': clean(m[2]), 'content': clean(body), 'conditionText': condition,
                 'choices': []}
        found = list(re.finditer(r'选项 ([ABC])「([^」]+)」：', line))
        if found:
            for i, c in enumerate(found):
                effect_text = line[c.end():found[i+1].start() if i+1 < len(found) else len(line)]
                feedback = effect_text.split('效果建议：', 1)[0] if '效果建议：' in effect_text else ''
                event['choices'].append({'key': c[1], 'text': clean(c[2]), 'feedback': clean(feedback).rstrip('；'),
                                         'effect': effects(effect_text)})
            if all(c['effect'].get('money', 0) < 0 for c in event['choices']):
                event['choices'].append({'key': 'C', 'text': '先免费抄写要点', 'feedback': '今天不花钱，保留要点。', 'effect': {}})
        else:
            effect_text = line.split('：', 1)[1]
            event['choices'] = [{'key': 'A', 'text': '继续', 'feedback': '', 'effect': effects(effect_text)}]
        # Extra pool constraints can appear alongside effects, never infer from narrative prose.
        event['constraintsText'] = effect_text if not found else ''
        if m[1] == 'RAND-L49':
            event['choices'][0].update(target='examMistake', targetGain=0.7)
        if m[1] == 'RAND-L51':
            event['choices'][0].update(target='discussion', targetGain=0.5)
        if m[1] == 'RAND-L59':
            event['choices'][0].update(target='lastStudy', targetGain=0.5)
        event['rules'], event['disabledReason'] = conditions(condition, event['constraintsText'])
        if m[1] == 'RAND-L49':
            event['disabledReason'] = '模考尚无可核实的逐题错题科目记录'
        output.append(event)
    assert len(output) == 360
    return output


def conditions(text, extra):
    """Compile explicit condition lines. Unknown prerequisites remain unavailable.

    No narrative keyword guessing at runtime, and no fabricated transaction history.
    """
    rules, unsupported = [], []
    field_names = {**FIELDS, **{f'【人物姓名_{n}】老师关系': k for n, k in RELATIONS.items()},
                   **{f'【人物姓名_{n}】关系': k for n, k in RELATIONS.items()}}
    field_pattern = '|'.join(map(re.escape, sorted(field_names, key=len, reverse=True)))
    for clause in text.split('；'):
        clause = clause.strip().rstrip('。')
        if not clause:
            continue
        if clause.startswith('第'):
            nums = re.findall(r'\d+', clause)
            rules.append({'type': 'week', 'min': int(nums[0]), 'max': int(nums[-1])})
            continue
        if clause.startswith('天气为') or clause == '雨后':
            types = {'晴': 'sun', '阴': 'cloud', '雷雨': 'thunder', '雨': 'rain', '雾霾': 'fog', '雾': 'fog', '雨后': 'afterRain'}
            names = clause.removeprefix('天气为').split('或')
            rules.append({'type': 'weather', 'values': [types[n] for n in names]})
            continue
        scalars = list(re.finditer(rf'({field_pattern})\s*(?:(≥|≤|>|<)\s*(\d+)|(\d+)—(\d+))', clause))
        if scalars:
            members = []
            for m in scalars:
                members.append({'type': 'value', 'field': field_names[m[1]], 'op': m[2] or 'range',
                                'value': float(m[3] or m[4]), 'max': float(m[5] or 0)})
            rules.append({'type': 'any', 'rules': members} if '或' in clause else {'type': 'all', 'rules': members})
            continue
        if clause.startswith('任一学科'):
            match = re.search(r'(≥|≤|>|<)\s*(\d+)', clause)
            if not match:
                raise ValueError('Unrecognized subject threshold: ' + clause)
            rules.append({'type': 'subjectThreshold', 'op': match[1], 'value': int(match[2])})
            continue
        if clause.startswith('累计学习'):
            rules.append({'type': 'studyCount', 'min': int(re.search(r'\d+', clause)[0])})
            continue
        if '模考记录' in clause:
            if '不要求' not in clause:
                rules.append({'type': 'exam'})
            continue
        if clause in ('不读取或编造过去名次', '不生成获奖或录取历史'):
            continue
        if clause in ('当前可查看实际留存的旧稿',):
            rules.append({'type': 'oldDraft'})
            continue
        if clause in ('实际有可查看的旧文件', '实际可查看旧文件', '实际可访问旧队资料', '实际可查看旧程序'):
            rules.append({'type': 'oldProgram'})
            continue
        if clause == '本周有未完成作业':
            rules.append({'type': 'unfinishedHomework'})
            continue
        if clause == '本周未锻炼':
            rules.append({'type': 'noAction', 'values': ['exercise']})
            continue
        if clause == '本周家教等经济劳动且本周学习':
            rules.append({'type': 'all', 'rules': [
                {'type': 'action', 'values': ['economy:part-time'], 'min': 1, 'weeks': 1},
                {'type': 'action', 'values': ['study'], 'min': 1, 'weeks': 1}]})
            continue
        if clause == '有真实收入或支出记录':
            rules.append({'type': 'transaction'})
            continue
        if clause in ('本周有真实购买记录', '本周已真实购买资料'):
            rules.append({'type': 'action', 'values': ['economy:buy-books', 'economy:buy-course'], 'min': 1, 'weeks': 1})
            continue
        if clause.startswith('本周') or clause.startswith('最近两周'):
            phrase = re.sub(r'^(?:本周|最近两周)', '', clause)
            if phrase in ('有真实现金消费记录', '真实现金消费', '有真实餐饮消费记录', '实际购买文具',
                          '实际使用有试用期的资料服务',
                          '实际沟通并确认交通支持', '实际参与尚未付款的资料合购讨论'):
                unsupported.append(clause)
                continue
            if phrase == '完成最近一次模考后的复盘行动':
                rules.append({'type': 'reviewLatestExam'})
                continue
            if phrase == '主动求助':
                values = ['rest:counseling']
            elif phrase in ('经济管理',):
                values = ['economy']
            elif phrase in ('家庭沟通',):
                values = ['social:parents', 'side:H02']
            elif phrase in ('已完成一次家教', '已完成家教'):
                values = ['economy:part-time']
            elif phrase in ('查看资料购买', '查看付费资料', '查看资料订单'):
                values = ['view:materials']
            elif phrase in ('了解付费课程', '查看补习'):
                values = ['view:course']
            elif phrase in ('整理资料',):
                values = ['homework']
            elif phrase in ('休息方式为午睡',):
                values = ['rest:nap']
            elif phrase in ('睡眠休息',):
                values = ['rest:sleep']
            else:
                phrase = phrase.replace('主动回忆', '回忆').replace('校内活动', '活动')
                phrase = re.sub(r'\s*≥\s*\d+\s*次', '', phrase)
                values = []
                for part in phrase.split('或'):
                    if part in SUBJECTS or part.endswith('学习') and part[:-2] in SUBJECTS:
                        values.append('study:' + SUBJECTS[part.removesuffix('学习')])
                    elif part.startswith('学习') and part[2:] in SUBJECTS:
                        values.append('study:' + SUBJECTS[part[2:]])
                    elif part.endswith('作业') and part[:-2] in SUBJECTS:
                        values.append('homework:' + SUBJECTS[part[:-2]])
                    elif part in ('学习', '社交', '作业', '休息', '回忆', '锻炼', '活动', '经济管理'):
                        values.append({'学习': 'study', '社交': 'social', '作业': 'homework', '休息': 'rest',
                                       '回忆': 'memory', '锻炼': 'exercise', '活动': 'activity', '经济管理': 'economy'}[part])
                    else:
                        unsupported.append(clause)
            if values:
                minimum = re.search(r'≥\s*(\d+)\s*次', clause)
                rules.append({'type': 'action', 'values': values, 'min': int(minimum[1]) if minimum else 1,
                              'weeks': 2 if clause.startswith('最近两周') else 1})
            continue
        unsupported.append(clause)
    # Effect-line eligibility restrictions are still explicit conditions.
    for m in re.finditer(r'(压力|焦虑)\s*<\s*(\d+)时', extra):
        rules.append({'type': 'value', 'field': FIELDS[m[1]], 'op': '<', 'value': int(m[2]), 'max': 0})
    return rules, '；'.join(unsupported)


def endings():
    text = (ROOT / '结局.md').read_text(encoding='utf-8-sig')
    output = {}
    for m, block in sections(text, r'^### ([A-Z]+\d{2})｜([^\n]+)'):
        block = re.split(r'^## ', block, maxsplit=1, flags=re.M)[0]
        if m[1][0] == 'C':
            # Preserve preparation and cost information; route confirmation buttons are rendered by the engine.
            block = re.split(r'\*\*按钮\*\*', block)[0]
            body = block
        else:
            body = re.sub(r'^\*\*[^\n]+\n', '', block.strip(), count=1)
        output[m[1]] = {'id': m[1], 'title': clean(m[2]), 'content': clean(body)}
    assert len(output) == 37
    return output


if __name__ == '__main__':
    data = {'stories': stories(), 'random': random_events(), 'endings': endings()}
    (ROOT / 'narrative-data.js').write_text(
        '// Compiled from 剧情.md、随机事件.md、结局.md. Rebuild with scripts/build-narrative.py.\n'
        '"use strict";\nwindow.AFONarrative = ' + json.dumps(data, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
    print('Compiled: 36 main, 6 side, 4 memories, 360 random events, 9 endings, 24 epilogues, 4 routes.')
