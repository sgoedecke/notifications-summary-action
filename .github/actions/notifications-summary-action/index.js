const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

async function fetchNotifications(octokit, hoursBack) {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  
  try {
    const { data } = await octokit.rest.activity.listNotificationsForAuthenticatedUser({
      since,
      per_page: 50
    });
    
    return data;
  } catch (error) {
    throw new Error(`Failed to fetch notifications: ${error.message}`);
  }
}

function formatNotificationsForAI(notifications) {
  if (notifications.length === 0) {
    return "No new notifications in the specified time period.";
  }
  
  return notifications.map(notification => {
    return `- **${notification.subject.title}** (${notification.subject.type}) in ${notification.repository.full_name}
  Reason: ${notification.reason}
  Updated: ${notification.updated_at}`;
  }).join('\n');
}

async function generateAISummary(formattedNotifications, aiToken, isSlack = false) {
  const formatInstruction = isSlack 
    ? 'Format the summary for Slack messaging (use Slack markdown format).'
    : 'Format the summary in GitHub markdown with clear sections and bullet points.';
    
  // Load prompt from YAML file
  const promptPath = path.join(__dirname, 'summary.prompt.yml');
  const promptData = yaml.load(fs.readFileSync(promptPath, 'utf8'));
  
  // Replace template variables
  const messages = promptData.messages.map(message => ({
    ...message,
    content: message.content
      .replace('{{formatInstruction}}', formatInstruction)
      .replace('{{notifications}}', formattedNotifications)
  }));

  try {
    // Use GitHub's AI inference endpoint
    const response = await axios.post(
      'https://models.github.ai/inference/chat/completions',
      {
        messages,
        model: promptData.model,
        max_tokens: 1000
      },
      {
        headers: {
          'Authorization': `Bearer ${aiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    throw new Error(`Failed to generate AI summary: ${error.message}`);
  }
}

async function sendSlackMessage(slackToken, slackUserId, summary, hasNotifications) {
  const today = new Date().toISOString().split('T')[0];
  
  const message = hasNotifications 
    ? summary 
    : '✅ No new notifications in the last 24 hours. All caught up!';
    
  const payload = {
    channel: slackUserId,
    text: `📬 Daily Notifications Summary - ${today}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📬 Daily Notifications Summary - ${today}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message
        }
      }
    ]
  };
  
  try {
    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${slackToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
    
    return response.data;
  } catch (error) {
    throw new Error(`Failed to send Slack message: ${error.message}`);
  }
}

async function createGitHubIssue(octokit, summary, hasNotifications) {
  const today = new Date().toISOString().split('T')[0];
  
  const title = `📬 Daily Notifications Summary - ${today}`;
  const body = hasNotifications 
    ? summary 
    : '✅ No new notifications in the last 24 hours. All caught up!';
    
  try {
    const { data } = await octokit.rest.issues.create({
      owner: github.context.repo.owner,
      repo: github.context.repo,
      title,
      body,
      labels: ['automated', 'notifications', 'summary']
    });
    
    return data;
  } catch (error) {
    throw new Error(`Failed to create GitHub issue: ${error.message}`);
  }
}

async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token', { required: true });
    const aiToken = core.getInput('ai-token', { required: true });
    const slackToken = core.getInput('slack-token');
    const slackUserId = core.getInput('slack-user-id');
    const hoursBack = parseInt(core.getInput('hours-back') || '24');
    
    // Validate Slack inputs
    if (slackToken && !slackUserId) {
      throw new Error('slack-user-id is required when slack-token is provided');
    }
    
    // Initialize GitHub client
    const octokit = github.getOctokit(githubToken);
    
    core.info('Fetching recent notifications...');
    const notifications = await fetchNotifications(octokit, hoursBack);
    
    core.info(`Found ${notifications.length} notifications`);
    core.setOutput('notification-count', notifications.length);
    
    let summary = '';
    
    if (notifications.length > 0) {
      const formattedNotifications = formatNotificationsForAI(notifications);
      core.info('Generating AI summary...');
      summary = await generateAISummary(formattedNotifications, aiToken, !!slackToken);
    }
    
    core.setOutput('summary', summary);
    
    // Send via Slack or create GitHub issue
    if (slackToken) {
      core.info('Sending Slack DM...');
      await sendSlackMessage(slackToken, slackUserId, summary, notifications.length > 0);
      core.info('✅ Sent summary via Slack DM');
    } else {
      core.info('Creating GitHub issue...');
      const issue = await createGitHubIssue(octokit, summary, notifications.length > 0);
      core.info(`✅ Created issue #${issue.number}`);
    }
    
    core.info(`✅ Processed ${notifications.length} notifications`);
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
