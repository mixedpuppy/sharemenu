/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, manager: Cm} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://gre/modules/Preferences.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Services",
                                  "resource://gre/modules/Services.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CustomizableUI",
                                  "resource:///modules/CustomizableUI.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Social",
                                  "resource:///modules/Social.jsm");

function createElementWithAttrs(document, type, attrs) {
  let element = document.createElement(type);
  Object.keys(attrs).forEach(function (attr) {
    element.setAttribute(attr, attrs[attr]);
  })
  return element;
}

function CreateWidget(reason) {
  let id = "share-menu-button"
  let widget = CustomizableUI.getWidget(id);
  // The widget is only null if we've created then destroyed the widget.
  // Once we've actually called createWidget the provider will be set to
  // PROVIDER_API.
  if (widget && widget.provider == CustomizableUI.PROVIDER_API)
    return;

  let shareButton = {
    id: "share-menu-button",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    introducedInVersion: "pref",
    type: "view",
    viewId: "PanelUI-shareMenuView",
    label: "Share",
    tooltiptext: "Share",
    onViewShowing: function(aEvent) {
      let doc = aEvent.target.ownerDocument;
    },
    onViewHiding: function() {
    },
    onBeforeCreated: function(doc) {
      // Bug 1223127,CUI should make this easier to do.
      if (doc.getElementById("PanelUI-shareMenuView"))
        return;
      let view = doc.createElement("panelview");
      view.id = "PanelUI-shareMenuView";
      doc.getElementById("PanelUI-multiView").appendChild(view);
      this.populateProviderMenu(doc);
    },
    populateProviderMenu: function(doc) {
      let view = doc.getElementById("PanelUI-shareMenuView");
      for (let el of [...view.childNodes])
        el.remove()

      let item = createElementWithAttrs(doc, "toolbarbutton", {
        "class": "subviewbutton",
        "label": "Copy Address",
        "oncommand": `var clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].
                        getService(Ci.nsIClipboardHelper);
                      clipboard.copyString(gBrowser.currentURI.spec);`
      });
      view.appendChild(item);
      item = createElementWithAttrs(doc, "toolbarbutton", {
        "class": "subviewbutton",
        "label": "Email Link...",
        "oncommand": "MailIntegration.sendLinkForBrowser(gBrowser.selectedBrowser);"
      });
      view.appendChild(item);
      item = createElementWithAttrs(doc, "menuseparator", {
        "id": "menu_shareMenuSeparator"
      });
      view.appendChild(item);

      let providers = Social.providers.filter(p => p.shareURL);
      for (let provider of providers) {
        let item = createElementWithAttrs(doc, "toolbarbutton", {
          "class": "subviewbutton",
          "label": provider.name,
          "image": provider.iconURL,
          "origin": provider.origin,
          "oncommand": 'sharePage("'+provider.origin+'");'
        });
        view.appendChild(item);
      }

      let url = Services.prefs.getCharPref("social.directories").split(',')[0];

      item = createElementWithAttrs(doc, "toolbarbutton", {
        "class": "subviewbutton",
        "label": "Add Service...",
        "oncommand": 'openUILinkIn("'+url+'", "tab");'
      });
      view.appendChild(item);
      item = createElementWithAttrs(doc, "toolbarbutton", {
        "class": "subviewbutton",
        "label": "Manage Services...",
        "oncommand": "BrowserOpenAddonsMgr('addons://list/service');"
      });
      view.appendChild(item);
    },
    onCreated: function(node) {
      // quick hack to add style for share icon
      if (!node || node.id != this.id)
        return;
      node.setAttribute("style", "list-style-image: url(chrome://browser/skin/Toolbar.png); -moz-image-region: rect(0px, 306px, 18px, 288px);");
    },
    observe: function(aSubject, aTopic, aData) {
      for (let win of CustomizableUI.windows) {
        let document = win.document;
        this.populateProviderMenu(document);
      }
    }
  };

  CustomizableUI.createWidget(shareButton);
  CustomizableUI.addListener(shareButton);
  Services.obs.addObserver(shareButton, "social:providers-changed", false);

};

// sharePage based on SocialShare.sharePage in browser-social.js
// target would be item clicked on for a context menu, but not handled in this demo
function sharePage(targetWindow) {
  let window = targetWindow;
  return function(providerOrigin, graphData, target) {
    with (window) { // XXX hacky and slow, make sure we have scope
    // graphData is an optional param that either defines the full set of data
    // to be shared, or partial data about the current page. It is set by a call
    // in mozSocial API, or via nsContentMenu calls. If it is present, it MUST
    // define at least url. If it is undefined, we're sharing the current url in
    // the browser tab.
    let pageData = graphData ? graphData : null;
    let sharedURI = pageData ? Services.io.newURI(pageData.url, null, null) :
                                gBrowser.currentURI;
    if (!SocialUI.canShareOrMarkPage(sharedURI))
      return;

    // the point of this action type is that we can use existing share
    // endpoints (e.g. oexchange) that do not support additional
    // socialapi functionality.  One tweak is that we shoot an event
    // containing the open graph data.
    let _dataFn;
    if (!pageData || sharedURI == gBrowser.currentURI) {
      messageManager.addMessageListener("PageMetadata:PageDataResult", _dataFn = (msg) => {
        messageManager.removeMessageListener("PageMetadata:PageDataResult", _dataFn);
        let pageData = msg.json;
        if (graphData) {
          // overwrite data retreived from page with data given to us as a param
          for (let p in graphData) {
            pageData[p] = graphData[p];
          }
        }
        sharePage(providerOrigin, pageData, target);
      });
      gBrowser.selectedBrowser.messageManager.sendAsyncMessage("PageMetadata:GetPageData", null, { target });
      return;
    }
    // if this is a share of a selected item, get any microformats
    if (!pageData.microformats && target) {
      messageManager.addMessageListener("PageMetadata:MicroformatsResult", _dataFn = (msg) => {
        messageManager.removeMessageListener("PageMetadata:MicroformatsResult", _dataFn);
        pageData.microformats = msg.data;
        sharePage(providerOrigin, pageData, target);
      });
      gBrowser.selectedBrowser.messageManager.sendAsyncMessage("PageMetadata:GetMicroformats", null, { target });
      return;
    }

    let provider = Social._getProviderFromOrigin(providerOrigin);
    if (!provider || !provider.shareURL) {
      return;
    }

    let shareEndpoint = OpenGraphBuilder.generateEndpointURL(provider.shareURL, pageData);
    window.open(shareEndpoint, "share-dialog", "chrome");
  }
  }
}

function windowProperty(targetWindow) {
  return {
    get: function() {
      // delete any getters for properties loaded from main.js so we only load main.js once
      return sharePage(targetWindow);
    },
    configurable: true,
    enumerable: true
  };
}

var Overlay = {
  startup: function(reason) {
    for (let win of CustomizableUI.windows) {
      this.setWindowScripts(win);
    }
    Services.obs.addObserver(this, "browser-delayed-startup-finished", false);
  },
  shutdown: function(reason) {
    Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    for (let win of CustomizableUI.windows) {
      delete win.sharePage;
    }
  },
  observe: function(window) {
    this.setWindowScripts(window);
  },
  setWindowScripts: function(window) {
    Object.defineProperty(window, "sharePage", windowProperty(window));
  }
}

function startup(data, reason) {
  CreateWidget(reason);
  Overlay.startup(reason);
}

function shutdown(data, reason) {
  Overlay.shutdown(reason);
  CustomizableUI.destroyWidget("share-menu-button");
}

function install() {
}

function uninstall() {
}
