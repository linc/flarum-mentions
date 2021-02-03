import { extend } from 'flarum/extend';
import TextEditor from 'flarum/components/TextEditor';
import TextEditorButton from 'flarum/components/TextEditorButton';
import ReplyComposer from 'flarum/components/ReplyComposer';
import EditPostComposer from 'flarum/components/EditPostComposer';
import avatar from 'flarum/helpers/avatar';
import usernameHelper from 'flarum/helpers/username';
import highlight from 'flarum/helpers/highlight';
import KeyboardNavigatable from 'flarum/utils/KeyboardNavigatable';
import { truncate } from 'flarum/utils/string';

import AutocompleteDropdown from './fragments/AutocompleteDropdown';

export default function addComposerAutocomplete() {
  extend(TextEditor.prototype, 'oncreate', function () {
    const $container = $('<div class="ComposerBody-mentionsDropdownContainer"></div>');
    const dropdown = new AutocompleteDropdown();
    const $editor = this.$('.TextEditor-editor').wrap('<div class="ComposerBody-mentionsWrapper"></div>');
    const searched = [];
    let mentionStart;
    let typed;
    let searchTimeout;

    // We store users returned from an API here to preserve order in which they are returned
    // This prevents the user list jumping around while users are returned.
    // We also use a hashset for user IDs to provide O(1) lookup for the users already in the list.
    const returnedUsers = Array.from(app.store.all('users'));
    const returnedUserIds = new Set(returnedUsers.map(u => u.id()));

    const applySuggestion = (replacement) => {
      app.composer.editor.replaceBeforeCursor(mentionStart - 1, replacement + ' ');

      dropdown.hide();
    };

    this.navigator = new KeyboardNavigatable();
    this.navigator
      .when(() => dropdown.active)
      .onUp(() => dropdown.navigate(-1))
      .onDown(() => dropdown.navigate(1))
      .onSelect(dropdown.complete.bind(dropdown))
      .onCancel(dropdown.hide.bind(dropdown))
      .bindTo($editor);

    console.log($editor);

    $editor
      .after($container)
      .on('click keyup input', function(e) {
        // Up, down, enter, tab, escape, left, right.
        if ([9, 13, 27, 40, 38, 37, 39].indexOf(e.which) !== -1) return;

        const selection = app.composer.editor.getSelectionRange();

        const cursor = selection[0];

        if (selection[1] - cursor > 0) return;

        // Search backwards from the cursor for an '@' symbol. If we find one,
        // we will want to show the autocomplete dropdown!
        const value = app.composer.fields.content();
        mentionStart = 0;
        for (let i = cursor - 1; i >= cursor - 30; i--) {
          const character = value.substr(i, 1);
          if (character === '@') {
            mentionStart = i + 1;
            break;
          }
        }

        console.log(mentionStart);

        dropdown.hide();
        dropdown.active = false;

        if (mentionStart) {
          typed = value.substring(mentionStart, cursor).toLowerCase();

          const makeSuggestion = function(user, replacement, content, className = '') {
            const username = usernameHelper(user);
            if (typed) {
              username.children = [highlight(username.text, typed)];
              delete username.text;
            }

            return (
              <button className={'PostPreview ' + className}
                onclick={() => applySuggestion(replacement)}
                onmouseenter={function() {
                  dropdown.setIndex($(this).parent().index());
                }}>
                <span className="PostPreview-content">
                  {avatar(user)}
                  {username} {' '}
                  {content}
                </span>
              </button>
            );
          };

          const userMatches = function(user) {
            const names = [
              user.username(),
              user.displayName()
            ];

            return names.some(value => value.toLowerCase().substr(0, typed.length) === typed);
          };

          const buildSuggestions = () => {
            const suggestions = [];

            // If the user has started to type a username, then suggest users
            // matching that username.
            if (typed) {
              returnedUsers.forEach(user => {
                if (!userMatches(user)) return;

                suggestions.push(
                  makeSuggestion(user, '@' + user.username(), '', 'MentionsDropdown-user')
                );
              });
            }

            // If the user is replying to a discussion, or if they are editing a
            // post, then we can suggest other posts in the discussion to mention.
            // We will add the 5 most recent comments in the discussion which
            // match any username characters that have been typed.
            if (app.composer.bodyMatches(ReplyComposer) || app.composer.bodyMatches(EditPostComposer)) {
              const composerAttrs = app.composer.body.attrs;
              const composerPost = composerAttrs.post;
              const discussion = (composerPost && composerPost.discussion()) || composerAttrs.discussion;

              if (discussion) {
                discussion.posts()
                  .filter(post => post && post.contentType() === 'comment' && (!composerPost || post.number() < composerPost.number()))
                  .sort((a, b) => b.createdAt() - a.createdAt())
                  .filter(post => {
                    const user = post.user();
                    return user && userMatches(user);
                  })
                  .splice(0, 5)
                  .forEach(post => {
                    const user = post.user();
                    suggestions.push(
                      makeSuggestion(user, '@' + user.username() + '#' + post.id(), [
                        app.translator.trans('flarum-mentions.forum.composer.reply_to_post_text', {number: post.number()}), ' — ',
                        truncate(post.contentPlain(), 200)
                      ], 'MentionsDropdown-post')
                    );
                  });
              }
            }

            if (suggestions.length) {
              dropdown.items = suggestions;
              m.render($container[0], dropdown.render());

              dropdown.show();
              const coordinates = app.composer.editor.getCaretCoordinates(mentionStart);
              const width = dropdown.$().outerWidth();
              const height = dropdown.$().outerHeight();
              const parent = dropdown.$().offsetParent();
              let left = coordinates.left;
              let top = coordinates.top - this.scrollTop + 15;
              if (top + height > parent.height()) {
                top = coordinates.top - this.scrollTop - height - 15;
              }
              if (left + width > parent.width()) {
                left = parent.width() - width;
              }
              dropdown.show(left, top);
            } else {
              dropdown.active = false;
              dropdown.hide();
            }
          };

          dropdown.active = true;

          buildSuggestions();

          dropdown.setIndex(0);
          dropdown.$().scrollTop(0);

          clearTimeout(searchTimeout);
          // Don't send API calls searching for users until at least 2 characters have been typed.
          // This focuses the mention results on users and posts in the discussion.
          if (typed.length > 1) {
            searchTimeout = setTimeout(function() {
              const typedLower = typed.toLowerCase();
              if (searched.indexOf(typedLower) === -1) {
                app.store.find('users', { filter: { q: typed }, page: { limit: 5 } }).then(results => {
                  results.forEach(u => {
                    if (!returnedUserIds.has(u.id())) {
                      returnedUserIds.add(u.id());
                      returnedUsers.push(u);
                    }
                  })
                  if (dropdown.active) buildSuggestions();
                });
                searched.push(typedLower);
              }
            }, 250);
          }
        }
      });
  });

  extend(TextEditor.prototype, 'toolbarItems', function(items) {
    items.add('mention', (
      <TextEditorButton onclick={() => this.attrs.composer.editor.insertAtCursor('@')} icon="fas fa-at">
        {app.translator.trans('flarum-mentions.forum.composer.mention_tooltip')}
      </TextEditorButton>
    ));
  });
}
