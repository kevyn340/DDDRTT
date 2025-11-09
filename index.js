
const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
    TextInputStyle, EmbedBuilder, ChannelType, PermissionsBitField, PermissionFlagsBits,
    RoleSelectMenuBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder
} = require("discord.js");
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// --- GERENCIAMENTO DA CONFIGURAÇÃO ---
const configPath = './config.json';
let config = {};

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const fileContent = fs.readFileSync(configPath, 'utf8');
            config = fileContent ? JSON.parse(fileContent) : {};
        } else {
            config = { staffRoleIds: [], categoryId: null, logChannelId: null, ticketTypes: [] };
            saveConfig();
        }
        config.staffRoleIds = config.staffRoleIds || [];
        config.ticketTypes = config.ticketTypes || [];
    } catch (error) {
        console.error("❌ Erro ao carregar config.json:", error);
        config = { staffRoleIds: [], categoryId: null, logChannelId: null, ticketTypes: [] };
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    } catch (error) { console.error("❌ Erro ao salvar config.json:", error); }
}

loadConfig();

// --- CLIENTE & COMANDOS ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('⚙️ [Admin] Configuração guiada do sistema de tickets.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('📢 [Admin] Envia o painel de tickets customizável.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(o => o.setName('channel').setDescription('Canal para enviar o painel.').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption(o => o.setName('style').setDescription('O estilo do painel.').setRequired(true).addChoices({ name: 'Botões', value: 'buttons' }, { name: 'Menu', value: 'menu' }))
        .addStringOption(o => o.setName('title').setDescription('O título da mensagem do painel.').setRequired(false))
        .addStringOption(o => o.setName('description').setDescription('A descrição ou regras do painel.').setRequired(false))
        .addStringOption(o => o.setName('image_url').setDescription('URL de uma imagem para o painel.').setRequired(false)),
    new SlashCommandBuilder()
        .setName('cr')
        .setDescription('📄 [Staff] Envia uma mensagem customizada em um ticket.')
        .setDefaultMemberPermissions(0),
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Bot online como ${client.user.tag}!`);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Comandos registrados com sucesso.');
    } catch (error) { console.error("❌ Erro ao registrar comandos:", error); }
});

// --- GERENCIADOR DE INTERAÇÕES ---
client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
    else if (interaction.isAnySelectMenu()) await handleSelectMenu(interaction);
});


// --- SETUP GUIADO ---
const setupSteps = [
    { id: 'roles', message: "**Passo 1 de 3:** Selecione os cargos da staff que gerenciarão os tickets.", component: () => new RoleSelectMenuBuilder().setCustomId('setup_select_roles').setPlaceholder('Selecione um ou mais cargos...').setMinValues(1).setMaxValues(10) },
    { id: 'category', message: "**Passo 2 de 3:** Selecione a categoria onde os tickets serão criados.", component: () => new ChannelSelectMenuBuilder().setCustomId('setup_select_category').setPlaceholder('Selecione uma categoria...').addChannelTypes(ChannelType.GuildCategory) },
    { id: 'logs', message: "**Passo 3 de 3:** Selecione o canal para onde os logs serão enviados.", component: () => new ChannelSelectMenuBuilder().setCustomId('setup_select_logs').setPlaceholder('Selecione um canal de texto...').addChannelTypes(ChannelType.GuildText) },
];

async function runSetupStep(interaction, stepIndex) {
    if (stepIndex >= setupSteps.length) {
        const finalEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Configuração Concluída!').setDescription('O sistema de tickets foi configurado.').addFields(
            { name: 'Cargos de Staff', value: config.staffRoleIds.map(id => `<@&${id}>`).join(', ') || 'Nenhum' },
            { name: 'Categoria de Tickets', value: config.categoryId ? `<#${config.categoryId}>` : 'Nenhuma' },
            { name: 'Canal de Logs', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Nenhum' }
        );
        const manageButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('manage_ticket_types').setLabel('Gerenciar Tipos de Ticket').setStyle(ButtonStyle.Primary).setEmoji('🔧'),
            new ButtonBuilder().setCustomId('setup_cancel').setLabel('Fechar').setStyle(ButtonStyle.Secondary)
        );
        return await interaction.update({ embeds: [finalEmbed], components: [manageButtons] });
    }
    const step = setupSteps[stepIndex];
    const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(step.message);
    const row = new ActionRowBuilder().addComponents(step.component());
    const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancelar').setStyle(ButtonStyle.Danger));
    const payload = { embeds: [embed], components: [row, cancelRow], ephemeral: true };
    if (interaction.isChatInputCommand()) await interaction.reply(payload); else await interaction.update(payload);
}

// --- FUNÇÃO CENTRAL DE CRIAÇÃO DE TICKET ---
async function createTicket(interaction, ticketType) {
    await interaction.deferReply({ ephemeral: true });

    const authorId = interaction.user.id;
    const existingTicket = interaction.guild.channels.cache.find(c => c.topic === `ticket_user:${authorId}`);
    if (existingTicket) {
        return interaction.editReply({ content: `❌ Você já tem um ticket aberto em <#${existingTicket.id}>.` });
    }

    try {
        const permissionOverwrites = [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: authorId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
            ...config.staffRoleIds.map(id => ({ id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] }))
        ];

        const channel = await interaction.guild.channels.create({
            name: `${ticketType.label}-${interaction.user.username}`.slice(0, 100),
            type: ChannelType.GuildText,
            topic: `ticket_user:${authorId}`,
            parent: config.categoryId,
            permissionOverwrites,
        });

        const welcomeEmbed = new EmbedBuilder().setColor("Green").setTitle(`${ticketType.emoji} Ticket de ${interaction.user.username}`).setDescription(`Bem-vindo! A equipe virá em breve.\n**Assunto:** ${ticketType.label}`);
        const closeButton = new ButtonBuilder().setCustomId('close_ticket_confirm').setLabel('Fechar Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒');
        await channel.send({ content: `${interaction.user}, ${config.staffRoleIds.map(id => `<@&${id}>`).join(' ')}`, embeds: [welcomeEmbed], components: [new ActionRowBuilder().addComponents(closeButton)] });

        await interaction.editReply({ content: `✅ Ticket criado em <#${channel.id}>!` });
        await log(interaction, `✅ Ticket para "${ticketType.label}" aberto por ${interaction.user.tag}`, channel.id, "Green");

    } catch (error) {
        console.error("Erro ao criar ticket:", error);
        await interaction.editReply({ content: '❌ Erro ao criar ticket. Verifique as permissões e configurações.' });
    }
}


// --- LÓGICA DOS COMANDOS SLASH ---
async function handleCommand(interaction) {
    const { commandName, options } = interaction;

    if (commandName === 'setup') {
        await runSetupStep(interaction, 0);
    }

    if (commandName === 'panel') {
        const channel = options.getChannel('channel');
        const style = options.getString('style');
        const title = options.getString('title') || "Central de Atendimento";
        const description = options.getString('description') || "Para iniciar, escolha uma das opções abaixo.";
        const imageUrl = options.getString('image_url');

        if (!config.ticketTypes || config.ticketTypes.length === 0) {
            return interaction.reply({ content: '❌ Adicione pelo menos um tipo de ticket no `/setup` antes de criar um painel.', ephemeral: true });
        }

        const panelEmbed = new EmbedBuilder().setColor(0x5865F2).setTitle(title).setDescription(description);
        if (imageUrl) try { panelEmbed.setImage(imageUrl) } catch { /* ignora url inválida */ }

        const components = new ActionRowBuilder();
        if (style === 'buttons') {
            components.addComponents(config.ticketTypes.map(type => new ButtonBuilder().setCustomId(`open_ticket_${type.value}`).setLabel(type.label).setStyle(ButtonStyle.Secondary).setEmoji(type.emoji)));
        } else {
            components.addComponents(new StringSelectMenuBuilder().setCustomId('open_ticket_menu').setPlaceholder('Selecione um assunto para abrir o ticket').addOptions(config.ticketTypes.map(t => ({ label: t.label, value: t.value, emoji: t.emoji }))));
        }

        await channel.send({ embeds: [panelEmbed], components: [components] });
        await interaction.reply({ content: `✅ Painel enviado para <#${channel.id}>.`, ephemeral: true });
    }

    if (commandName === 'cr') {
        const isStaff = interaction.member.roles.cache.some(role => config.staffRoleIds.includes(role.id));
        const isTicketChannel = interaction.channel.topic && interaction.channel.topic.startsWith('ticket_user:');

        if (!isStaff || !isTicketChannel) {
            return interaction.reply({ content: '❌ Este comando só pode ser usado pela Staff em um canal de ticket.', ephemeral: true });
        }
        
        const modal = new ModalBuilder().setCustomId('cr_modal').setTitle('Criar Mensagem Customizada');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cr_title').setLabel("Título").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cr_desc').setLabel("Descrição/Conteúdo").setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cr_image').setLabel("URL da Imagem (Opcional)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }
}

// --- LÓGICA DOS MENUS DE SELEÇÃO ---
async function handleSelectMenu(interaction) {
    const { customId, values } = interaction;

    if (customId === 'setup_select_roles') { config.staffRoleIds = values; saveConfig(); await runSetupStep(interaction, 1); }
    if (customId === 'setup_select_category') { config.categoryId = values[0]; saveConfig(); await runSetupStep(interaction, 2); }
    if (customId === 'setup_select_logs') { config.logChannelId = values[0]; saveConfig(); await runSetupStep(interaction, 3); }
    
    if (customId === 'remove_ticket_type_menu') {
        config.ticketTypes = config.ticketTypes.filter(t => t.value !== values[0]);
        saveConfig();
        await interaction.update({ content: '✅ Tipo de ticket removido!', components: [], embeds: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
    }

    if (customId === 'open_ticket_menu') {
        const ticketType = config.ticketTypes.find(t => t.value === values[0]);
        if (ticketType) await createTicket(interaction, ticketType);
    }
}

// --- LÓGICA DOS BOTÕES ---
async function handleButton(interaction) {
    const { customId } = interaction;

    if (customId === 'setup_cancel') {
        await interaction.update({ content: 'Configuração cancelada.', embeds: [], components: [] });
        return setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
    }

    if (customId === 'manage_ticket_types') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🔧 Gerenciador de Tipos de Ticket').setDescription("Adicione ou remova os botões que aparecerão no painel.\n\n**Tipos Atuais:**" + (config.ticketTypes.length > 0 ? '\n' + config.ticketTypes.map(t => `${t.emoji} **${t.label}**`).join('\n') : '\nNenhum tipo criado ainda.'));
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('add_ticket_type').setLabel('Adicionar').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('remove_ticket_type').setLabel('Remover').setStyle(ButtonStyle.Danger).setEmoji('➖').setDisabled(config.ticketTypes.length === 0),
            new ButtonBuilder().setCustomId('setup_back').setLabel('Voltar').setStyle(ButtonStyle.Secondary)
        );
        return await interaction.update({ embeds: [embed], components: [buttons] });
    }

    if (customId === 'setup_back') { return await runSetupStep(interaction, 99); }

    if (customId === 'add_ticket_type') {
        const modal = new ModalBuilder().setCustomId('add_ticket_type_modal').setTitle('Adicionar Tipo de Ticket');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type_name').setLabel("Nome do Botão (Ex: Suporte)").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowRowBuilder().addComponents(new TextInputBuilder().setCustomId('type_emoji').setLabel("Emoji do Botão (Ex: 🛠️)").setStyle(TextInputStyle.Short).setRequired(true)));
        return await interaction.showModal(modal);
    }

    if (customId === 'remove_ticket_type') {
        const menu = new StringSelectMenuBuilder().setCustomId('remove_ticket_type_menu').setPlaceholder('Selecione um tipo para remover...').addOptions(config.ticketTypes.map(t => ({ label: t.label, value: t.value, emoji: t.emoji })));
        return await interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (customId.startsWith('open_ticket_') && !customId.includes('menu')) {
        const ticketType = config.ticketTypes.find(t => t.value === customId.replace('open_ticket_', ''));
        if (ticketType) await createTicket(interaction, ticketType);
    }
    
    if (customId === 'close_ticket_confirm') {
        const embed = new EmbedBuilder().setColor("Yellow").setTitle("❓ Confirmação").setDescription("Tem certeza que deseja fechar este ticket?");
        const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_execute').setLabel('Sim').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('close_ticket_cancel').setLabel('Não').setStyle(ButtonStyle.Secondary));
        return await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
    }

    if (customId === 'close_ticket_execute') {
        const channel = interaction.channel;
        await interaction.update({ content: '🔴 O ticket será excluído em 5 segundos...', embeds: [], components: [] });
        await log(interaction, `🔴 Ticket #${channel.name} fechado por ${interaction.user.tag}.`, channel.id, "Red");
        return setTimeout(() => channel.delete().catch(console.error), 5000);
    }

    if (customId === 'close_ticket_cancel') { return await interaction.message.delete(); }
}

// --- LÓGICA DOS MODAIS ---
async function handleModal(interaction) {
    if (interaction.customId === 'add_ticket_type_modal') {
        await interaction.deferUpdate();
        const name = interaction.fields.getTextInputValue('type_name');
        const emoji = interaction.fields.getTextInputValue('type_emoji');
        const value = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 100);

        if(config.ticketTypes.some(t => t.value === value)) {
            return await interaction.followUp({ content: '❌ Já existe um tipo com este nome.', ephemeral: true });
        }
        config.ticketTypes.push({ value, label: name, emoji });
        saveConfig();
        
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🔧 Gerenciador de Tipos de Ticket').setDescription("Tipo adicionado!\n\n**Tipos Atuais:**" + '\n' + config.ticketTypes.map(t => `${t.emoji} **${t.label}**`).join('\n'));
        const buttons = new ActionRowBuilder().addComponents(
             new ButtonBuilder().setCustomId('add_ticket_type').setLabel('Adicionar').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('remove_ticket_type').setLabel('Remover').setStyle(ButtonStyle.Danger).setEmoji('➖').setDisabled(config.ticketTypes.length === 0),
            new ButtonBuilder().setCustomId('setup_back').setLabel('Voltar').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    if (interaction.customId === 'cr_modal') {
        const title = interaction.fields.getTextInputValue('cr_title');
        const description = interaction.fields.getTextInputValue('cr_desc');
        const imageUrl = interaction.fields.getTextInputValue('cr_image');
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865F2);
        if (imageUrl) try { embed.setImage(imageUrl) } catch { /* ignora */ }
        await interaction.channel.send({ embeds: [embed] });
        await interaction.reply({ content: '✅ Mensagem enviada!', ephemeral: true });
    }
}

// --- FUNÇÃO DE LOG ---
async function log(interaction, message, channelId, color = "Default") {
    if (!config.logChannelId) return;
    const logChannel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
    if (!logChannel) return;
    const logEmbed = new EmbedBuilder().setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() }).setDescription(message).setColor(color).setTimestamp();
    if (channelId) logEmbed.addFields({ name: 'Canal', value: `<#${channelId}>` });
    logChannel.send({ embeds: [logEmbed] }).catch(console.error);
}

// --- LOGIN ---
client.login(process.env.TOKEN);