import { AuthRequiredError, SelectorError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
    site: 'twitter',
    name: 'lists',
    description: 'Get Twitter/X lists for a user',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'user', positional: true, type: 'string', required: false },
        { name: 'limit', type: 'int', default: 50 },
    ],
    columns: ['name', 'members', 'followers', 'mode'],
    func: async (page, kwargs) => {
        let targetUser = kwargs.user;
        if (!targetUser) {
            await page.goto('https://x.com/home');
            await page.wait({ selector: '[data-testid="primaryColumn"]' });
            const href = await page.evaluate(`() => {
            const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
            return link ? link.getAttribute('href') : null;
        }`);
            if (!href) {
                throw new AuthRequiredError('x.com', 'Could not find logged-in user profile link. Are you logged in?');
            }
            targetUser = href.replace('/', '');
        }
        await page.goto(`https://x.com/${targetUser}/lists`);
        await page.wait(3);
        const pageText = await page.evaluate(`() => document.body.innerText`);
        if (!pageText) {
            throw new SelectorError('Twitter lists', 'Empty page text');
        }
        const results = [];
        const lines = pageText.split('\n');
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            if (line.includes('位成员') && line.includes('位关注者')) {
                const nameMatch = line.match(/^(.+?)\s*·?\s*(\d+)\s*位成员/);
                const followersMatch = line.match(/([\d.]+[K千]?)\s*位关注者/);
                const isPrivate = line.includes('锁定列表');
                if (nameMatch) {
                    results.push({
                        name: nameMatch[1].replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s\/\-·]/g, '').trim(),
                        members: nameMatch[2],
                        followers: followersMatch ? followersMatch[1] : '0',
                        mode: isPrivate ? 'private' : 'public'
                    });
                }
            } else if (line.includes('位关注者') && !line.includes('位成员')) {
                const followersMatch = line.match(/([\d.]+[K千]?)\s*位关注者/);
                const isPrivate = line.includes('锁定列表');
                let name = '';
                if (i > 0) {
                    const prevLine = lines[i - 1].trim();
                    if (prevLine && !prevLine.includes('列表') && !prevLine.includes('位成员') && !prevLine.includes('位关注者') && !prevLine.includes('@') && !prevLine.includes('你的')) {
                        name = prevLine.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s\/\-·]/g, '').trim();
                    }
                }
                if (name && followersMatch) {
                    results.push({
                        name: name,
                        members: '0',
                        followers: followersMatch[1],
                        mode: isPrivate ? 'private' : 'public'
                    });
                }
            } else if (line.includes('位成员') && !line.includes('位关注者')) {
                const membersMatch = line.match(/(\d+)\s*位成员/);
                if (membersMatch) {
                    let name = '';
                    let followers = '0';
                    let isPrivate = line.includes('锁定列表');
                    if (i > 0) {
                        const prevLine = lines[i - 1].trim();
                        if (prevLine && !prevLine.includes('你的列表') && !prevLine.includes('位成员') && !prevLine.includes('位关注者') && !prevLine.includes('@')) {
                            name = prevLine.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s\/\-·]/g, '').trim();
                        }
                    }
                    if (i < lines.length - 1) {
                        const nextLine = lines[i + 1].trim();
                        const followersMatch = nextLine.match(/([\d.]+[K千]?)\s*位关注者/);
                        if (followersMatch) {
                            followers = followersMatch[1];
                            if (nextLine.includes('锁定列表')) isPrivate = true;
                        } else if (nextLine.includes('锁定列表')) {
                            isPrivate = true;
                        }
                    }
                    if (name && membersMatch[1]) {
                        results.push({
                            name: name,
                            members: membersMatch[1],
                            followers: followers,
                            mode: isPrivate ? 'private' : 'public'
                        });
                    }
                }
            }
            i++;
        }
        if (results.length === 0) {
            throw new SelectorError('Twitter lists', `Could not parse list data`);
        }
        return results.slice(0, kwargs.limit);
    }
});