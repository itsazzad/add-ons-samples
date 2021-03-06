// Copyright 2017 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Collection of functions to handle user interactions with the add-on.
 *
 * @constant
 */
var ActionHandlers = {
  /**
   * Displays the home page card -- form that asks for people to meet with.
   *
   * @param {Event} e - Event from Gmail
   * @return {Card[]}
   */
  showHomePage: function(e) {
    var settings = getSettingsForUser();
    var opts = {
      startHour: settings.startHour,
      endHour: settings.endHour,
      durationMinutes: settings.durationMinutes,
      emailAddresses: [],
      state: {
        subject: 'Meeting request',
        timezone: getUserTimezone(),
      },
    };
    var card = buildSearchCard(opts);
    return [card];
  },

  /**
   * Displays the meeting search card.
   *
   * @param {Event} e - Event from Gmail
   * @return {Card[]}
   */
  showSearchForm: function(e) {
    var settings = getSettingsForUser();
    var message = getCurrentMessage(e);
    var people = extractRecipients(message, settings.emailBlacklist);
    var subject = message.getSubject();

    var opts = {
      startHour: settings.startHour,
      endHour: settings.endHour,
      durationMinutes: settings.durationMinutes,
      emailAddresses: people,
      state: {
        messageId: e.messageId,
        subject: subject,
        timezone: getUserTimezone(),
      },
    };
    var card = buildSearchCard(opts);
    return [card];
  },

  /**
   * Searches for free times and displays a card with the results.
   *
   * @param {Event} e - Event from Gmail
   * @return {ActionResponse}
   */
  findTimes: function(e) {
    var deadlineMonitor = buildDeadlineMonitor(DEFAULT_DEADLINE_SECONDS);
    var formInputs = e.commonEventObject.formInputs;
    var emailAddresses = _.union(
      formInputs.participants ? 
        formInputs.participants[''].stringInputs.value :
        [],
      formInputs.additionalParticipants ?
        formInputs.additionalParticipants[''].stringInputs.value[0].split(/[\s,]+/) :
        []
    );
    var state = _.assign(JSON.parse(e.parameters.state), {
      emailAddresses: emailAddresses,
      durationMinutes: parseInt(formInputs.duration[''].stringInputs.value[0]),
      startHour: parseInt(formInputs.start[''].stringInputs.value[0]),
      endHour: parseInt(formInputs.end[''].stringInputs.value[0]),
    });

    // Validate time ranges -- start must be before end
    if (state.endHour <= state.startHour) {
      return CardService.newActionResponseBuilder()
          .setNotification(
              CardService.newNotification()
                  .setText('End time must be after start time.')
                  .setType(CardService.NotificationType.ERROR)
          )
          .build();
    }

    // Validate time ranges -- meeting duration must fit between start/end times
    if (state.durationMinutes > (state.endHour - state.startHour) * 60) {
      return CardService.newActionResponseBuilder()
          .setNotification(
              CardService.newNotification()
                  .setText(
                      'Duration too long. Try a shorter duration or expand the start and end times.'
                  )
                  .setType(CardService.NotificationType.ERROR)
          )
          .build();
    }

    var settings = getSettingsForUser();
    var scheduler = buildScheduler({
      durationMinutes: state.durationMinutes,
      startHour: state.startHour,
      endHour: state.endHour,
      timezone: state.timezone,
      emailAddresses: state.emailAddresses,
      meetingIntervalMinutes: settings.meetingIntervalMinutes,
      deadlineMonitor: deadlineMonitor,
    });

    var responseBuilder = CardService.newActionResponseBuilder();
    try { // Handle exceptions from our deadline monitor gracefully
      var response = scheduler.findAvailableTimes();
      if (response.freeTimes.length) {
        var card = buildResultsCard({
          availableTimes: response.freeTimes,
          subject: state.subject,
          showPartialResponseWarning: response.isPartialResponse,
          timezone: state.timezone,
          state: state,
        });
        responseBuilder.setNavigation(
            CardService.newNavigation().pushCard(card)
        );
      } else {
        responseBuilder.setNotification(
            CardService.newNotification()
                .setText('No times available for selected participants')
                .setType(CardService.NotificationType.INFO)
        );
      }
    } catch (err) {
      if (err instanceof DeadlineExceededError) {
        responseBuilder.setNotification(
            CardService.newNotification()
                .setText('Taking too long to find a time. Try fewer participants.')
                .setType(CardService.NotificationType.WARNING)
        );
      } else {
        // Handle all other errors in the entry points
        throw err;
      }
    }

    return responseBuilder.build();
  },

  /**
   * Creates an event and displays a confirmation card.
   *
   * @param {Event} e - Event from Gmail
   * @return {ActionResponse}
   */
  createMeeting: function(e) {
    var state = JSON.parse(e.parameters.state);
    var formInputs = e.commonEventObject.formInputs;
    var eventTime = moment(
        parseFloat(formInputs.time[''].stringInputs.value[0])
    ).tz(state.timezone);
    var endTime = eventTime.clone().add(state.durationMinutes, 'minutes');
    var event = {
      attendees: _.map(state.emailAddresses, function(person) {
        return {email: person};
      }),
      start: {
        dateTime: eventTime.toISOString(),
      },
      end: {
        dateTime: endTime.toISOString(),
      },
      summary: formInputs.subject[''].stringInputs.value[0],
      description: formInputs.note[''].stringInputs.value[0],
    };

    event = Calendar.Events.insert(event, 'primary');
    var card = buildConfirmationCard({
      eventLink: event.htmlLink,
      eventTime: eventTime.valueOf(),
      timezone: state.timezone,
    });
    return CardService.newActionResponseBuilder()
        .setNavigation(CardService.newNavigation().pushCard(card))
        .build();
  },

  /**
   * Shows the user settings card.
   * @param {Event} e - Event from Gmail
   * @return {UniversalActionResponse}
   */
  showSettings: function(e) {
    var settings = getSettingsForUser();
    var card = buildSettingsCard({
      durationMinutes: settings.durationMinutes,
      startHour: settings.startHour,
      endHour: settings.endHour,
      meetingIntervalMinutes: settings.meetingIntervalMinutes,
      searchRangeDays: settings.searchRangeDays,
      emailBlacklist: settings.emailBlacklist,
    });
    return CardService.newUniversalActionResponseBuilder()
        .displayAddOnCards([card])
        .build();
  },

  /**
   * Saves the user's settings.
   *
   * @param {Event} e - Event from Gmail
   * @return {ActionResponse}
   */
  saveSettings: function(e) {
    var formInputs = e.commonEventObject.formInputs;
    var settings = {
      durationMinutes: parseInt(formInputs.duration[''].stringValues.values[0]),
      startHour: parseInt(formInputs.start[''].stringValues.values[0]),
      endHour: parseInt(formInputs.end[''].stringValues.values[0]),
      meetingIntervalMinutes: parseInt(formInputs.meetingInterval[''].stringValues.values[0]),
      searchRangeDays: parseInt(formInputs.searchRange[''].stringValues.values[0]),
      emailBlacklist: _.split(formInputs.emailBlacklist[''].stringValues.values[0], /\s/),
    };
    updateSettingsForUser(settings);
    return CardService.newActionResponseBuilder()
        .setNavigation(CardService.newNavigation().popCard())
        .setNotification(
            CardService.newNotification()
                .setText('Settings saved.')
                .setType(CardService.NotificationType.INFO)
        )
        .build();
  },

  /**
   * Resets the user settings to the defaults.
   * @param {Event} e - Event from Gmail
   * @return {ActionResponse}
   */
  resetSettings: function(e) {
    resetSettingsForUser(settings);
    var settings = getSettingsForUser();
    var card = buildSettingsCard({
      durationMinutes: settings.durationMinutes,
      startHour: settings.startHour,
      endHour: settings.endHour,
      meetingIntervalMinutes: settings.meetingIntervalMinutes,
      searchRangeDays: settings.searchRangeDays,
      emailBlacklist: settings.emailBlacklist,
    });
    return CardService.newActionResponseBuilder()
        .setNavigation(CardService.newNavigation().updateCard(card))
        .setNotification(
            CardService.newNotification()
                .setText('Settings reset.')
                .setType(CardService.NotificationType.INFO)
        )
        .build();
  },
};
